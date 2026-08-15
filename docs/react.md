# Deploying React apps

React projects are auto-detected: the CLI runs your build script and finds the
output folder.

## Vite

`vite build` outputs to `dist/` — detected automatically:

```bash
cd my-vite-app
deploy up                        # local control plane
deploy up --provider netlify --site my-site
deploy up --provider vercel
```

## Create React App

`react-scripts build` outputs to `build/` — also auto-detected:

```bash
cd my-cra-app
deploy up
```

## Custom output folders

```bash
deploy up --dir out
# or permanently:
echo '{ "outDir": "out" }' > .deployrc.json
```

## Build-time environment variables

`VITE_*` / `REACT_APP_*` variables are baked in during the build, which runs on
your machine, so they just work:

```bash
VITE_API_URL=https://api.example.com deploy up
```

## Client-side routing (React Router)

With `BrowserRouter`, deep links (`/about`) are resolved by the *server* on a
static host — and 404 unless you add a fallback to `index.html`.

**Netlify** — add `public/_redirects`:

```
/* /index.html 200
```

**Vercel** — add `vercel.json`:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

**Local control plane** — currently serves files as-is, so deep links 404.
The root (`/`) works fine. (SPA fallback is on the roadmap.)

**Cloudflare Pages / S3** — use the equivalent SPA routing config for each host.

## React projects with a separate API

The CLI ships static output. Point your API calls at a separate host or use
Vercel/Netlify functions configured in your project — both hosts keep function
support when they build themselves, but note this CLI uploads *built output*,
so functions must be pre-built into the output folder to be included.

## Preview a branch

```bash
git checkout -b feat/landing
deploy preview --provider netlify
# URL on the branch preview — production untouched
```
