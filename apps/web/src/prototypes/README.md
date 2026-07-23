# Prototype-only components

This directory contains isolated UI experiments. These components are not production application routes and must not be imported by `src/main.ts`, `src/App.vue`, or production components.

- Open prototypes only through their dedicated `*-prototype.html` entry files during local development.
- Treat colors, dimensions, data, and interaction patterns here as disposable experiments, not production tokens or contracts.
- Move an accepted design into production components explicitly; do not make the production application depend on a prototype component.
- Verify a production build does not emit any `*-prototype.html` files or prototype component chunks.
