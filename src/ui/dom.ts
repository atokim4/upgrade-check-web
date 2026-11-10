type Child = Node | string | false | null | undefined;
type Attrs = Record<string, string | number | boolean | undefined>;

/** Creates an element. Text is always set as text, never parsed as HTML: repo contents are untrusted. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined && c !== "") el.append(c);
  return el;
}

/** Text with `code` spans, as the scanners write their messages. */
export function richText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  text.split(/(`[^`]+`)/).forEach((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) frag.append(h("code", {}, part.slice(1, -1)));
    else if (part) frag.append(part);
  });
  return frag;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A small stroked icon from path data, sized by CSS. */
export function icon(paths: string[], className = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  copy: ["M9 9h10v11H9z", "M5 15V4h10"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
  alert: ["M12 3l9.5 17h-19z", "M12 10v4", "M12 17.2v.1"],
  info: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M12 11v6", "M12 7.5v.1"],
};

/** A button that copies `text` and says so, for screen readers too. */
export function copyButton(label: string, text: () => string, className = "btn btn-small"): HTMLButtonElement {
  const labelEl = h("span", {}, label);
  const btn = h("button", { type: "button", class: className }, icon(ICONS.copy), labelEl);
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text());
      btn.replaceChildren(icon(ICONS.check), h("span", {}, "Copied"));
      btn.classList.add("is-done");
    } catch {
      btn.replaceChildren(icon(ICONS.alert), h("span", {}, "Select and copy by hand"));
    }
    window.setTimeout(() => {
      btn.replaceChildren(icon(ICONS.copy), labelEl);
      btn.classList.remove("is-done");
    }, 2000);
  });
  return btn;
}
