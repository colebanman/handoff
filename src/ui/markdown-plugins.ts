import remarkGfm from 'remark-gfm'
import { MATH_REHYPE_PLUGINS, remarkMarkdownMath } from './markdown-math'

/** Shared by chat, the file preview and the standalone Markdown viewer. */
export const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMarkdownMath]
export const MARKDOWN_REHYPE_PLUGINS = MATH_REHYPE_PLUGINS
