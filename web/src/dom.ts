/**
 * Tiny DOM builder. All data is inserted as text nodes; there is no innerHTML anywhere in
 * the site. Attributes are limited to a fixed allowlist, and links can only be internal
 * routes or a short list of documentation URLs that come from AgentWeave itself.
 */
declare const safeHrefBrand: unique symbol;
export type SafeHref = string & { readonly [safeHrefBrand]: true };

const ROUTE = /^#\/[a-z-]*$/;
export function route(r: string): SafeHref {
  if (!ROUTE.test(r)) throw new Error("invalid internal route");
  return brand(r);
}
function brand(s: string): SafeHref {
  // The single place a string becomes a SafeHref; callers above validate first.
  return s as SafeHref;
}

/** Documentation pages AgentWeave's own checks link to. Anything else is shown as plain text. */
const DOC_URLS = new Set([
  "https://agentskills.io/specification",
  "https://code.claude.com/docs/en/memory",
  "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
]);
export function docHref(url: string): SafeHref | null {
  return DOC_URLS.has(url) ? brand(url) : null;
}

const ATTR = /^(aria-[a-z]+|data-[a-z-]+|role|tabindex|type|for|title|name|value|placeholder|autocomplete|spellcheck|lang|id|class|inputmode|aria-controls)$/;

export type Child = string | number | Node | null | undefined | false;
export type Props = {
  class?: string;
  attrs?: Record<string, string>;
  href?: SafeHref;
  external?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  onKeydown?: (e: KeyboardEvent) => void;
  onChange?: (e: Event) => void;
  onInput?: (e: Event) => void;
  onSubmit?: (e: SubmitEvent) => void;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    if (!ATTR.test(k)) throw new Error(`attribute not allowed: ${k}`);
    el.setAttribute(k, v);
  }
  if (props.href !== undefined) {
    el.setAttribute("href", props.href);
    if (props.external) {
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }
  }
  if (props.hidden) el.hidden = true;
  if (props.disabled) el.setAttribute("disabled", "");
  const base: HTMLElement = el;
  if (props.onClick) base.addEventListener("click", props.onClick);
  if (props.onKeydown) base.addEventListener("keydown", props.onKeydown);
  if (props.onChange) base.addEventListener("change", props.onChange);
  if (props.onInput) base.addEventListener("input", props.onInput);
  if (props.onSubmit) base.addEventListener("submit", props.onSubmit);
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replaces content and keeps it announced for screen readers if it is a live region. */
export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
