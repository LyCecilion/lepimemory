/**
 * esbuild `text` loader 把 `panel.css` 作为默认导出的字符串带入 bundle。
 * 仅服务本插件的样式文本（宿主其余样式由平台提供）。
 */
declare module '*.css' {
  const css: string;
  export default css;
}
