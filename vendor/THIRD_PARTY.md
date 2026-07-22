# Third-party browser assets

The files in this directory are bundled into JQL2Keys so the application can
start without access to public CDNs.

| Asset | Version | License | Upstream |
|---|---:|---|---|
| Vue global production build (`vue.global.prod.js`) | 3.5.18 | MIT | https://github.com/vuejs/core/tree/v3.5.18 |
| JSZip browser build (`jszip.min.js`) | 3.10.1 | MIT | https://github.com/Stuk/jszip/tree/v3.10.1 |
| Tailwind generated stylesheet (`tailwind.min.css`) | 3.4.17 | MIT | https://github.com/tailwindlabs/tailwindcss/tree/v3.4.17 |

`tailwind.min.css` is generated from `tailwind.input.css`,
`../tailwind.config.js`, and the class names in the SPA HTML.
