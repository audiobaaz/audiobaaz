# Audiobaaz: coming-soon branch

This branch holds one static page that says Audiobaaz is on its way. The product code is on `main`,
unchanged.

- Show the page: in Dokploy, open the app that serves `audiobaaz.com`, set its branch to
  `coming-soon` and deploy.
- Back to the product: set the branch to `main` and deploy.

What is here: `index.html` (the page, one screen, no scrolling), `server.js` (Node built-ins only;
it serves the page for every path, files from `public/`, and `/healthz`), `nixpacks.toml` (nothing
to install or build), `package.json` and an empty `package-lock.json` (so any `npm ci` still
passes), and `public/` (icons and images).

Run it locally: `node server.js`, then open http://localhost:3000.
