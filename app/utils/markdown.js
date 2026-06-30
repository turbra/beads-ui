import DOMPurify from 'dompurify';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { marked } from 'marked';

const MARKDOWN_CACHE_LIMIT = 200;

/** @type {Map<string, string>} */
const markdown_cache = new Map();

/**
 * Render Markdown safely as HTML using marked and DOMPurify.
 * Returns a lit-html TemplateResult via the unsafeHTML directive so it can be
 * embedded directly in templates.
 *
 * @param {string} markdown - Markdown source text
 */
export function renderMarkdown(markdown) {
  return unsafeHTML(renderMarkdownHtml(markdown));
}

/**
 * Render Markdown safely as a sanitized HTML string.
 *
 * @param {string} markdown - Markdown source text
 */
export function renderMarkdownHtml(markdown) {
  const key = String(markdown);
  const cached = markdown_cache.get(key);
  if (cached !== undefined) {
    markdown_cache.delete(key);
    markdown_cache.set(key, cached);
    return cached;
  }
  const parsed = /** @type {string} */ (marked.parse(markdown));
  const html_string = DOMPurify.sanitize(parsed);
  markdown_cache.set(key, html_string);
  if (markdown_cache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest_key = markdown_cache.keys().next().value;
    if (oldest_key !== undefined) {
      markdown_cache.delete(oldest_key);
    }
  }
  return html_string;
}

/**
 * Clear cached Markdown output.
 */
export function clearMarkdownCache() {
  markdown_cache.clear();
}

/**
 * Get current Markdown cache size.
 */
export function getMarkdownCacheSize() {
  return markdown_cache.size;
}
