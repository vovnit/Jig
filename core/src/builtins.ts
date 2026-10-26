// Things the runtime ships so every platform renders them identically:
// default styles per component, named shape paths, and composite controls
// written in the spec format itself (path 1 of custom controls: composition).

import type { NodeSpec } from "./spec.ts";

export const TYPE_ALIASES: Record<string, string> = {
  vstack: "column",
  hstack: "row",
  zstack: "overlay",
  stack: "overlay",
  label: "text",
  input: "textfield",
  switch: "toggle",
  icon: "shape",
  svg: "shape",
  img: "image",
};

export function defaultStyle(type: string, variant: unknown): Record<string, unknown> {
  switch (type) {
    case "button":
      switch (variant) {
        case "secondary":
          return { paddingX: 16, paddingY: 11, radius: 12, background: "surface", color: "accent" };
        case "plain":
          return { paddingX: 4, paddingY: 6, color: "accent" };
        case "danger":
          return { paddingX: 16, paddingY: 11, radius: 12, background: "danger", color: "onAccent" };
        default:
          return { paddingX: 16, paddingY: 11, radius: 12, background: "accent", color: "onAccent" };
      }
    case "textfield":
      return { paddingX: 12, paddingY: 11, radius: 10, background: "surface", color: "text" };
    case "divider":
      return { background: "border" };
    case "card":
      return {};
    default:
      return {};
  }
}

export const COLOR_KEYS = new Set(["background", "color", "borderColor", "fill", "stroke", "tint", "placeholderColor"]);

// 24×24 viewBox, stroke-free unless noted.
export const SHAPES: Record<string, string> = {
  star: "M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95z",
  heart: "M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.7 1.2 4.3 2.4.6-1.2 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z",
  check: "M9.5 16.6 5.2 12.3l-1.4 1.4 5.7 5.7 11-11-1.4-1.4z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  minus: "M5 11h14v2H5z",
  circle: "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20z",
  ring: "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20zm0 2.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 1 1 0-15z",
  square: "M3 3h18v18H3z",
  rounded: "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4z",
  close: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z",
  chevronLeft: "M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12z",
  chevronRight: "M8.6 6.4 10 5l7 7-7 7-1.4-1.4 5.6-5.6z",
  trash: "M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7zm4 2v8h1.5v-8zm2.5 0v8H14v-8z",
  bell: "M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1z",
  drop: "M12 2.5S5 10.2 5 14.5a7 7 0 0 0 14 0C19 10.2 12 2.5 12 2.5z",
  pill: "M8.5 3.5a5 5 0 0 1 7.07 0l4.93 4.93a5 5 0 0 1-7.07 7.07L3.5 15.57zm-5 12.07 6.94-6.94 7.07 7.07-6.94 6.94a5 5 0 0 1-7.07-7.07z",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5h-2v6l5 3 1-1.7-4-2.3z",
  calendar: "M7 2h2v2h6V2h2v2h3v17H4V4h3zm-1 7v10h12V9z",
  flame: "M12 2s1 3.5-1.5 6S7 12 7 15a5 5 0 0 0 10 0c0-2-1-3.5-1-3.5s-.5 2-2 2.5c0 0 1.5-4.5-2-12z",
  leaf: "M20 4S8 3 5 10c-2 4.5.5 8 .5 8L4 20l1.4 1.4 1.6-1.6S10.5 22 15 20c7-3 5-16 5-16z",
  sparkle: "M12 2l2.2 6.6L21 11l-6.8 2.4L12 20l-2.2-6.6L3 11l6.8-2.4z",
  home: "M12 3 2 11h3v10h5v-6h4v6h5V11h3z",
  edit: "M4 17.2V20h2.8l8.3-8.3-2.8-2.8zm14.7-8.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.8 1.8 2.8 2.8z",
};

/** Composite controls, built from primitives in the spec format. */
export const BUILTIN_COMPONENTS: Record<string, NodeSpec> = {
  // {"type": "progress", "value": "{{done / total}}"}
  progress: {
    type: "overlay",
    style: { height: "{{props.height ?? 8}}", radius: "{{(props.height ?? 8) / 2}}", background: "{{props.track ?? 'surface'}}", align: "start" },
    children: [
      {
        type: "spacer",
        style: {
          width: "{{pct(props.value)}}",
          height: "100%",
          radius: "{{(props.height ?? 8) / 2}}",
          background: "{{props.color ?? 'accent'}}",
          grow: 0,
        },
      },
    ],
  },
  // {"type": "ring", "value": "{{glasses / goal}}", "size": 120, "label": "{{glasses}}"}
  ring: {
    type: "overlay",
    style: { width: "{{props.size ?? 96}}", height: "{{props.size ?? 96}}" },
    children: [
      {
        type: "shape",
        viewBox: "0 0 100 100",
        path: "M50 6a44 44 0 1 0 0 88 44 44 0 1 0 0-88z",
        fill: "none",
        stroke: "{{props.track ?? 'surface'}}",
        strokeWidth: "{{props.thickness ?? 10}}",
        style: { width: "100%", height: "100%" },
      },
      {
        type: "shape",
        viewBox: "0 0 100 100",
        path: "{{arc(50, 50, 44, 0, clamp(props.value, 0, 1) * 360)}}",
        fill: "none",
        stroke: "{{props.color ?? 'accent'}}",
        strokeWidth: "{{props.thickness ?? 10}}",
        lineCap: "round",
        style: { width: "100%", height: "100%" },
      },
      {
        type: "column",
        if: "props.label != null",
        style: { align: "center" },
        children: [
          { type: "text", variant: "title", value: "{{props.label}}" },
          { type: "text", variant: "caption", if: "props.caption != null", value: "{{props.caption}}" },
        ],
      },
    ],
  },
  // {"type": "check", "checked": "{{item.done}}", "onTap": {"toggle": "item.done"}}
  check: {
    type: "overlay",
    style: { width: 26, height: 26 },
    children: [
      {
        type: "shape",
        path: "@circle",
        fill: "{{props.checked ? (props.color ?? 'accent') : 'none'}}",
        stroke: "{{props.checked ? (props.color ?? 'accent') : 'border'}}",
        strokeWidth: 2,
        style: { width: "100%", height: "100%" },
      },
      { type: "shape", if: "props.checked", path: "@check", fill: "onAccent", style: { width: 18, height: 18 } },
    ],
  },
  // {"type": "card", "children": [...]}: a padded surface column
  card: {
    type: "column",
    style: { padding: 16, gap: 8, radius: 16, background: "surface" },
    children: "$children" as unknown as NodeSpec[],
  },
};
