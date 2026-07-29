# Static prototype rules

UI prototypes are standalone `apps/web/*-prototype.html` files. They are not production routes and must not be imported by `src/main.ts`, `src/App.vue`, or production components.

- All prototypes must use plain HTML, CSS, and native JavaScript. Vue components, `*-prototype.ts` mounting entries, Vue Router routes, and Element Plus runtime entries are prohibited for prototypes.
- Reuse `src/styles.css` for VRC design tokens and `public/prototype-base.css` for shared prototype controls.
- Use paths relative to each HTML file so prototypes work both through Vite and when opened directly with `file://`.
- Keep page-specific layout and interaction styles inside the prototype HTML unless they are genuinely shared by multiple prototypes.
- Treat prototype data and behavior as isolated experiments, not production contracts. Move accepted designs into production components explicitly.
- Verify images, fonts, responsive layout, native interactions, and console output in both HTTP and direct-file modes before considering a prototype complete.
