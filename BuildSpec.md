# napkinRing: Build Spec

An online guest book. Four napkin rings each carry an NFC chip whose URL opens this site. Guests sign in, see who has used their ring, and see everyone who has visited.

This spec is written to be handed to Claude Code. Build the site with the Hallmark design skill (`npx skills add nutlope/hallmark -g`, then "use hallmark to build the site described in BUILD_SPEC.md"). If Hallmark is too complex or does not work, fall back to hand-written CSS.

**This repo is public. Never put the shared key, chip URLs, hostnames of private services, or `TS_AUTHKEY` in any file.** Use placeholders.

---

## 1. Stack
- Static HTML, CSS and vanilla JS only. No framework, no build step, no npm dependencies at runtime.
- Backend: an existing, publicly reachable PocketBase instance, called directly from the browser.
- Hosting: Docker container (nginx) with a Tailscale sidecar, deployed from this GitHub repo through a Portainer git stack, published with Tailscale Funnel.

## 2. Repo layout
```
/
  index.html
  css/            (styles)
  js/             (app logic + config)
  Dockerfile
  docker-compose.yml
  tailscale/
    serve.json
  README.md
  BUILD_SPEC.md
```
- `js/config.js` holds one non-secret value: the PocketBase base URL (placeholder `https://POCKETBASE_HOST_PLACEHOLDER`).

## 3. How a guest arrives
- Each chip holds a URL of the form `https://<site-host>/#ring=<1-4>&key=<shared-key>`.
- The key and ring are in the URL **fragment** so they never reach server logs or referrers.
- On load, the page reads the fragment, keeps `ring` and `key` in memory (and sessionStorage for refreshes), then removes the fragment from the address bar with `history.replaceState`.
- If the key or ring is missing or invalid, show a friendly "Tap your napkin ring to sign the guest book" message instead of the form.
- The shared key is never rotated.

## 4. PocketBase setup (done by hand in the admin UI, not by the site)

### Collection `guestbook` (Base type)
| Field | Type | Settings |
|---|---|---|
| guest_name | Text | Required, max length 80 |
| date | Date | Required |
| comment | Text | Optional, max length 1000 |
| dinner_rating | Number | Optional, min 1, max 5, integers only |
| ring | Text | Required (see rules for allowed values) |

Keep the built-in `created` autodate field for audit purposes. The user-facing `date` is separate and editable.

### API rules
- **List/Search and View:** allowed only when the request header `X-Napkin-Key` equals the shared key. In PocketBase rule syntax this is a comparison on `@request.headers.x_napkin_key`.
- **Create:** the same header check, plus `ring` must be one of "1", "2", "3", "4".
- **Update and Delete:** locked (superusers only).
- The key appears only inside these rule strings. It is never stored in this repo.

### Other PocketBase settings
- **Rate limiting:** enable it in Settings and set a conservative per-IP limit on create requests (suggest around 5 per minute) and a looser one on reads.
- **Trusted proxy headers:** set this so PocketBase sees real client IPs through Tailscale Funnel. Without it, all guests may share one IP and one rate-limit bucket. Test after deploy.
- **CORS:** PocketBase's allowed origins are set at startup with the `--origins` flag (default allows all). Restrict it to the site's hostname if practical. The browser sends a custom header, so the preflight must allow `X-Napkin-Key`.

## 5. Front end behavior

### Main view (default)
- A single form, centered vertically and horizontally.
- Fields:
  - **Name:** required. Autocomplete suggestions come only from `guest_name` values already in the database (case-insensitive, de-duplicated, loaded once on page load, filtered as the guest types).
  - **Date:** required. Pre-filled with today's date; the guest may change it before submitting.
  - **Comment:** optional.
  - **Dinner rating:** optional, five tappable circles (1 to 5), no library.
- Submit posts to PocketBase with the `X-Napkin-Key` header and the ring from the URL.
- On success: replace the form with a simple thank-you message (placeholder text, to be edited later). The guest can sign again with no restrictions.
- On failure: show a real error. Distinguish a rate-limit response (429) from a rejected key (403/404) from a network error. **Never show "thanks" unless the server confirmed the save.**

### Two modals (buttons on the main view and the thank-you state)
1. **This ring:** all entries for the current ring, newest first, with a heading "Guest N" matching the ring number.
2. **Everyone:** all entries from all rings, newest first, with a ring filter (All, Guest 1, Guest 2, Guest 3, Guest 4). Load all entries (paginate through the API behind the scenes; no "load more" button).
- Each entry shows: name, date, rating (as filled circles), comment.
- Modals must trap focus, close on Escape and on backdrop click, and work on a phone.

### Copy
Placeholders only, to be edited later: heading text, subtitle, thank-you message, empty-state text. Do not invent facts about the event or host.

## 6. Design direction
- Simple. Light, warm off-white background. Warm grays for text and borders. One muted terracotta accent, similar to Claude's palette.
- Generous white space. Single column. Mobile-first, since guests arrive by phone tap.
- Large touch targets (at least 44px). Respect `prefers-reduced-motion`.
- Pass accessibility basics: sufficient contrast, visible focus, labeled inputs.
- With Hallmark: let it deal themes and pick the one closest to "warm, calm, minimal". Ensure its lint passes at phone width and that the form really submits.

## 7. Deployment

### Dockerfile (adapted from the Python familyTree project)
- Base image: a small nginx image.
- Copy the site files into nginx's web root.
- Listen on port 80. No runtime install, no Python, no `EXPOSE 5001`.
- Drop the GitHub-API commit-SHA step; this page does not display a version.

### docker-compose.yml
- Two services: the site container and a Tailscale sidecar. PocketBase is already running elsewhere and is **not** part of this stack.
- Site container: `restart: unless-stopped`, `network_mode: service:<sidecar service name>`, no published ports, no Flask env vars.
- Sidecar: image `tailscale/tailscale:latest`, hostname `napkinring` (lowercase, no underscores), environment from familyTree:
  - `TS_AUTHKEY=${TS_AUTHKEY}` (set only in the Portainer stack's environment)
  - `TS_EXTRA_ARGS=--advertise-tags=tag:container`
  - `TS_STATE_DIR=/var/lib/tailscale`
  - `TS_SERVE_CONFIG=/config/serve.json`
- Volumes: a named volume for Tailscale state, `/dev/net/tun`, and the repo's `tailscale/` folder mounted at `/config`.
- Capabilities: `net_admin`, `sys_module`.
- `restart: unless-stopped`.
- Name all services and volumes with the `napkinring` prefix.

**Portainer caveat:** familyTree bind-mounts the serve config from an absolute host path. To mount the repo's `tailscale/` folder from a git stack instead, enable Portainer's relative path volumes option for the stack and set its host path. If that option is not available, fall back to an absolute host path where the repo is checked out, as in familyTree.

### tailscale/serve.json
- Terminate HTTPS on 443 using the node's cert domain.
- Proxy `/` to the site container at `http://127.0.0.1:80`.
- Enable Funnel (`AllowFunnel`) for the node's `:443` entry.
- Contains no secrets.
- Prerequisite in the tailnet policy: the `funnel` node attribute must be granted to `tag:container`.

### Portainer
- Create a stack from the public GitHub repo, build from the Dockerfile, and enter `TS_AUTHKEY` in the stack's environment variables.
- Optionally enable the redeploy webhook or polling so a `git push` updates the site.

## 8. Chips
Write four NFC URLs, one per ring, using the real hostname and key (kept outside the repo):
`https://<napkinring-host>/#ring=1&key=<shared-key>` through `ring=4`.

## 9. Acceptance tests (after deploy)
1. Opening the bare URL with no fragment shows the "tap your ring" message, not the form.
2. A post without the key header is rejected by PocketBase.
3. A post with the key and a valid ring succeeds and appears in both modals.
4. A ring value outside 1 to 4 is rejected.
5. Rapid repeated posts trigger the rate limit and show the 429 message, and the limit applies per guest, not globally.
6. Funnel works from a phone that is not on the tailnet.
7. Autocomplete suggests names from old entries only.
8. The page works at phone width and with keyboard-only navigation.

## 10. Accepted tradeoffs
- Anyone holding a chip can read the key, so it is a gate and not strong security.
- A lost ring cannot be revoked without changing the key and rewriting all four chips.
- The list rule also requires the key, so the API cannot be read without it.
