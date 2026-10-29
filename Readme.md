# napkinRing

An online guest book. Four napkin rings each carry an NFC chip. Tapping a ring opens this site, where guests sign the book, see who has used their ring, and see everyone who has visited.

- Static HTML, CSS and vanilla JS
- Backend: [PocketBase](https://pocketbase.io), called directly from the browser
- Hosting: nginx container + Tailscale sidecar, published with Tailscale Funnel, deployed from this repo through Portainer

> **This repo is public.** Never commit the shared key, the chip URLs, or `TS_AUTHKEY`. Everywhere below, `YOUR_KEY` is a placeholder.

---

## How the shared key works

The key is a gate that keeps people who have never held a ring from reading or writing entries. It travels like this:

1. Each chip holds a URL like:
   `https://<napkinring-host>/#ring=2&key=YOUR_KEY`
2. The browser asks nginx for the page. Everything after the `#` (the fragment) is **never sent to the server**, so the key does not appear in nginx or Funnel logs.
3. The page's JavaScript reads `ring` and `key` from the fragment, keeps them in memory (and sessionStorage so a refresh still works), then clears the fragment from the address bar.
4. Every request to PocketBase, both reads and writes, includes the key as an HTTP header:
   `X-Napkin-Key: YOUR_KEY`
5. PocketBase evaluates the collection's API rules. If the header matches the key written into the rule, the request is allowed. Otherwise it is rejected.

**The website never validates the key.** The page is only a messenger. If the JS tried to check the key itself, the real key would have to sit in the code where anyone could read it. PocketBase is the only place that compares it.

### Tradeoffs
- Anyone who reads a chip (or opens dev tools on a guest's phone) can see the key. It is a gate, not strong security.
- The key is never rotated. A lost ring cannot be revoked without changing the key and rewriting all four chips.
- Use a random alphanumeric key. Avoid quotes, backslashes and spaces, because the key is pasted into a rule string.

---

## PocketBase setup (all done in the admin UI)

### 1. Create the collection

New collection, type **Base**, named `guestbook`:

| Field | Type | Settings |
|---|---|---|
| guest_name | Text | Required, max length 80 |
| date | Date | Required |
| comment | Text | Optional, max length 1000 |
| dinner_rating | Number | Optional, min 1, max 5, integers only |
| ring | Text | Required |

PocketBase's built-in `created` field is kept for auditing. `date` is the user-facing, editable date.

### 2. Set the API rules

Open the collection's **API Rules** tab. Replace `YOUR_KEY` with the real key.

**List/Search rule and View rule:**
```
@request.headers.x_napkin_key = "YOUR_KEY"
```

**Create rule:**
```
@request.headers.x_napkin_key = "YOUR_KEY" && (@request.body.ring = "1" || @request.body.ring = "2" || @request.body.ring = "3" || @request.body.ring = "4")
```

**Update rule and Delete rule:** leave locked (the padlock state, superusers only). Do not type anything in them.

Notes:
- PocketBase lowercases header names and replaces hyphens with underscores, so `X-Napkin-Key` becomes `@request.headers.x_napkin_key`.
- A header reference on its own is not a valid rule. It must be compared with `=` against a quoted value, or you get `Invalid rule... invalid or incomplete filter expression`.
- Use plain double quotes, not curly quotes.
- An **empty** rule field means open to everyone. A **locked** rule shows a padlock. Make sure List and View are not left empty by accident.
- The ring field must be named exactly `ring` for the create rule to work.

### 3. Rate limiting

Settings, then the rate limit section: enable it and set conservative limits. Suggested starting point is about 5 create requests per minute per IP, with looser limits on reads.

### 4. Real client IPs behind Funnel

Behind Tailscale Funnel and the sidecar, PocketBase may see the proxy's address instead of each guest's. If so, every guest shares one rate-limit bucket. In Settings, configure the **trusted proxy headers** so PocketBase reads the real client IP. Test this after deploying (see below).

### 5. CORS

PocketBase's allowed origins are set at startup with the `--origins` flag, not in the admin UI. The default allows all origins. Restricting it to the site's hostname is optional hardening. Because the browser sends a custom header (`X-Napkin-Key`), the preflight request must be allowed to carry it.

---

## What failures look like

When a rule fails, PocketBase's response depends on the action. A failed create typically returns a 400-series error, while a failed list can return a normal 200 with zero results instead of an error. The front end therefore:

- treats any non-success response on a post as a failure and **never shows "thanks" unless the server confirmed the save**;
- distinguishes a rate-limit response (429) from other failures;
- treats an empty list with suspicion rather than assuming there are no guests.

Confirm the real behavior during the tests below and adjust the messages if needed.

---

## Deployment

| File | Purpose |
|---|---|
| `Dockerfile` | `nginx:alpine`, copies `index.html`, `css/` and `js/` only |
| `docker-compose.yml` | Site container + Tailscale sidecar (hostname `napkinring`) |
| `tailscale/serve.json` | Serve config: HTTPS on 443, proxy `/` to the site, Funnel enabled |

- PocketBase is already running and publicly reachable; it is **not** part of this stack. Its URL goes in `js/config.js` as the only configuration value (not a secret).
- Create a Portainer stack from this repo and enter `TS_AUTHKEY` in the stack's environment variables. It is the only secret, and it never goes in the repo.
- The sidecar mounts the `tailscale/` folder at `/config`. Portainer git stacks need the **relative path volumes** option enabled for a relative mount. Otherwise use an absolute host path where the repo is checked out.
- Your tailnet policy must grant the `funnel` node attribute to `tag:container`, or Funnel is ignored.
- Optionally enable Portainer's redeploy webhook or polling so a `git push` updates the site.

---

## Programming the chips

Write four NFC URLs, one per ring, using the real hostname and key (kept outside this repo):

```
https://<napkinring-host>/#ring=1&key=YOUR_KEY
https://<napkinring-host>/#ring=2&key=YOUR_KEY
https://<napkinring-host>/#ring=3&key=YOUR_KEY
https://<napkinring-host>/#ring=4&key=YOUR_KEY
```

---

## Acceptance tests (after deploy)

1. The bare URL with no fragment shows a "tap your ring" message, not the form.
2. A request to PocketBase without the `X-Napkin-Key` header is rejected (or returns no records).
3. A post with the correct key and a valid ring succeeds and appears in both modals.
4. A ring value outside 1 to 4 is rejected.
5. Rapid repeated posts trigger the rate limit and show the 429 message, and the limit applies per guest, not globally.
6. Funnel works from a phone that is not on the tailnet.
7. Name autocomplete suggests names from old entries only.
8. The page works at phone width and with keyboard-only navigation.

---

## More detail

See `BUILD_SPEC.md` for the full front-end and design specification.
