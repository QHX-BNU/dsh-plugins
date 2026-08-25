/**
 * dsh-show-image —— 服务端入口（host half）。
 *
 * 注册一个 `show_image` 工具：读取本地图片文件（png/jpg/jpeg/webp/gif），
 * 写入持久化附件库（内容寻址去重 + 元数据校验），并把字节以 base64 data URL
 * 嵌入工具结果 presentation（`presentationMeta`），由客户端（lib/client.js）
 * 渲染成对话内联图片卡片，点击打开页面内灯箱大图。
 *
 * 关键设计：
 *  - **模型侧只见文本**：`output.render` 只输出路径列表，图片字节绝不进入
 *    session 的模型可见内容 / 模型历史。任何路由（纯文本多模态皆可）都不会
 *    因此报 `UNSUPPORTED_CONTENT`，旧会话也不损坏。
 *  - **展示侧走 presentation**：图片字节放到工具结果 `meta.images`，由客户端
 *    直接渲染，不经过会话消息内容块。
 *  - **不依赖会话 readAttachment RPC**：该 RPC 只服务「被模型可见内容引用」的
 *    附件，与「图片不进模型历史」天然冲突，故弃用。
 *  - 主题适配：按钮/浮层不依赖 brand-primary（深色主题下它是近白色），统一用
 *    `--dsw-alias-*` 安全语义变量（见记忆：主题适配要点）。
 */
import z from '@deepseek-ai/schemastery';
import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** 插件名（与 cordis.patch.yml 的 id 一致）。 */
export const name = 'dsh-show-image';

/** 声明依赖：工具注册表 + 系统提示词注册表 + 附件服务。 */
export const inject = ['tools', 'systemPrompt', 'attachments'];

/** 附件库支持的位图格式（版本一致媒体类型）。 */
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const Config = z.object({
  /** 单次最多显示多少张。 */
  maxImages: z.number().default(12),
  /** 单张读取上限（与附件服务上限取更小者执行）。 */
  maxBytes: z.number().default(8 * 1024 * 1024),
  /** 单张可嵌入会话展示的最大字节数（data URL 随会话日志持久化，超限报错防日志膨胀）。 */
  maxEmbedBytes: z.number().default(2 * 1024 * 1024),
  /** 默认网格列数（1-6）。 */
  defaultColumns: z.number().default(3),
});

/** 单张图片的展示元数据（tool-result presentation 用）。 */
const IMAGE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    name: { type: 'string' },
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    dataUrl: { type: 'string', required: true },
  },
};

/** 把字节编码成浏览器可直接渲染的 base64 data URL。 */
function bytesToDataUrl(data, mediaType) {
  return `data:${mediaType};base64,${data.toString('base64')}`;
}

/** 把模型给的路径解析成绝对路径（相对路径对进程 cwd 解析）。 */
function resolvePath(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return '';
  const trimmed = raw.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

export function apply(ctx, config) {
  // 防御：初始化异常绝不让宿主崩溃（与 dsh-usage-panel 的做法一致）。
  try {
    // 系统提示词：引导模型在需要「给用户看图」时调用 show_image。
    ctx.systemPrompt.section({
      name: 'tool:show_image',
      order: 113,
      text: 'Use the show_image tool to DISPLAY images to the user in the WebUI conversation (screenshots, rendered diagrams, generated art, UI mockups, charts): pass the absolute file paths. The images render as an inline card the user can click to enlarge; you receive only the paths back. Do not use it to analyze images yourself — use read_image for that.',
    });
  } catch (error) {
    ctx.logger.warn(`dsh-show-image: systemPrompt 注册失败（不影响工具）：${error && error.message ? error.message : String(error)}`);
  }

  try {
    registerShowImageTool(ctx, config);
  } catch (error) {
    ctx.logger.error(`dsh-show-image: 工具注册失败（插件已安全跳过）：${error && error.message ? error.message : String(error)}`);
  }
}

export function registerShowImageTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'show_image',
    description: 'Display one or more local image files to the user as an inline image card in the WebUI conversation. Pass absolute paths of png/jpg/jpeg/webp/gif files. The human sees the images (click to enlarge); you receive only the paths back.',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        description: 'Absolute paths of the image files to display.',
        items: { type: 'string' },
      },
      captions: {
        type: 'array',
        description: 'Optional per-image captions shown under each image.',
        items: { type: 'string' },
      },
      columns: {
        type: 'number',
        description: `Grid columns (1-6, default ${config.defaultColumns}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: { type: 'array', required: true, items: IMAGE_ITEM_SCHEMA },
        },
      },
      // 模型可见：纯文本路径列表（图片字节绝不进模型历史）。
      render: (_args, value) => [
        { type: 'text', text: value.images.map((img, index) => `${index + 1}. ${img.path}`).join('\n') },
      ],
      // 展示侧：图片字节以 data URL 交给客户端内联渲染。
      presentationMeta: (_args, value) => ({ images: value.images }),
    },
    async execute(args, exec) {
      const attachments = ctx.get('attachments');
      if (attachments === undefined) throw new Error('show_image: attachment service is not available in this composition');

      const paths = Array.isArray(args.paths) ? args.paths : [];
      if (paths.length === 0) throw new Error('show_image: paths must be a non-empty array');
      if (paths.length > config.maxImages) throw new Error(`show_image: at most ${config.maxImages} images per call`);

      const columns = args.columns;
      if (columns !== undefined && (!Number.isInteger(columns) || columns < 1 || columns > 6)) {
        throw new Error('show_image: columns must be an integer between 1 and 6');
      }

      // 附件服务可能有更严的单图上限（默认 5MB）——按两者中更小的执行。
      const serviceLimit = attachments.imageLimits && typeof attachments.imageLimits.maxImageBytes === 'number'
        ? attachments.imageLimits.maxImageBytes
        : undefined;
      const byteLimit = serviceLimit !== undefined ? Math.min(config.maxBytes, serviceLimit) : config.maxBytes;

      const images = [];
      for (const rawPath of paths) {
        const extension = extname(rawPath).toLowerCase();
        const declared = MEDIA_TYPES[extension];
        if (declared === undefined) {
          throw new Error(`show_image: unsupported extension "${extension || rawPath}" (supported: png, jpg, jpeg, webp, gif)`);
        }

        const absPath = resolvePath(rawPath);
        if (absPath === '') throw new Error('show_image: each path must be a non-empty string');

        let data;
        try {
          data = await readFile(absPath);
        } catch (error) {
          throw new Error(`show_image: cannot read "${rawPath}": ${error && error.message ? error.message : String(error)}`);
        }

        if (data.byteLength > byteLimit) {
          throw new Error(`show_image: ${rawPath} (${data.byteLength} bytes) exceeds the ${byteLimit}-byte limit${serviceLimit !== undefined ? ` (attachment service cap ${serviceLimit})` : ''}`);
        }
        if (data.byteLength > config.maxEmbedBytes) {
          throw new Error(`show_image: ${rawPath} (${data.byteLength} bytes) exceeds the ${config.maxEmbedBytes}-byte embed limit; raise maxEmbedBytes in the dsh-show-image plugin config to allow larger images`);
        }

        let ref;
        try {
          ref = await attachments.saveImage({
            data,
            mediaType: declared,
            ...(basename(absPath).length > 0 ? { name: basename(absPath) } : {}),
          });
        } catch (error) {
          throw new Error(`show_image: failed to store "${rawPath}": ${error && error.message ? error.message : String(error)}`);
        }

        images.push({
          path: absPath,
          ...(ref.name !== undefined ? { name: ref.name } : {}),
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          dataUrl: bytesToDataUrl(data, ref.mediaType),
        });
      }
      return { images };
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'images',
      title: `显示 ${(args.paths ?? []).length} 张图片`,
      rawInput: (args.paths ?? []).join(', '),
    }),
    presentResult: (args, result) => {
      if (result.isError) return undefined;
      const images = result.meta && result.meta.images;
      if (!Array.isArray(images)) return undefined;
      return {
        card: 'generic',
        kind: 'images',
        title: `${images.length} 张图片`,
        images,
      };
    },
  }));
}
