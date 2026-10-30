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

An NFC chip can only store a URL, and a browser cannot add a header from a link. That is why the chip carries the key in the fragment and the page's JavaScript adds the header.

### Tradeoffs
- Anyone who reads a chip (or opens dev tools on a guest's phone) can see the key. It is a gate, not strong security.
- The key is never rotated. A lost ring cannot be revoked without changing the key and rewriting all four chips.
- Use a random alphanumeric key. Avoid quotes, backslashes and spaces, because the key is pasted into a rule string.

---

## Deployment

| File | Purpose |
|---|---|
| `Dockerfile` | `nginx:alpine`, copies `index.html`, `css/` and `js/` only |
| `docker-compose.yml` | Site container + Tailscale sidecar (hostname `napkinring`) |
| `tailscale/serve.json` | Serve config: HTTPS on 443, proxy `/` to the site, Funnel enabled |

- PocketBase is already running and publicly reachable; it is **not** part of this stack. Its URL goes in `js/config.js` as the only configuration value (not a secret).
- Create a Portainer stack from this repo and enter `TS_AUTHKEY` in the stack's environment variables. It is the only secret, and it never goes in the repo.
- The sidecar mounts the `tailscale/` folder at `/config`. Portainer git stacks need the **relative path volumes** option enabled for a relative mount (`./tailscale:/config`). Otherwise use an absolute host path where the repo is checked out.
- Your tailnet policy must grant the `funnel` node attribute to `tag:container`, or Funnel is ignored.
- The site files are baked into the image, so any change to the repo only shows up after Portainer pulls and **rebuilds**. Use "Pull and redeploy" with the re-build option. Optionally enable the redeploy webhook or polling so a `git push` updates the site.

---

## Configuration after install

Do these in order once the stack is running.

### 1. Point the site at PocketBase

Edit `js/config.js` and replace the placeholder with your PocketBase address (not a secret):

```js
window.NAPKIN_CONFIG = {
  pocketbaseUrl: 'https://pocketbase.tail32217.ts.net',
};
```

Commit, push, and redeploy the stack. If the page shows **"Could not reach the guest book"**, this value is usually the cause (still the placeholder, or a wrong address).

### 2. Generate the key

Run one of these and save the result in a password manager. It goes into the PocketBase rules and the chip URLs only, never into this repo.

```bash
# Hex, 32 characters (recommended)
openssl rand -hex 16
```

```bash
# Alphanumeric only, 32 characters, no extra tools
LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32; echo
```

```bash
# Python
python3 -c "import secrets; print(secrets.token_hex(16))"
```

Tips:
- 24 to 32 characters is plenty. Small chips (like NTAG213, about 144 bytes) have limited space, so check that your URL plus key fits.
- Do not use `openssl rand -base64`. Its output can contain `+`, `/` and `=`, which cause trouble in URLs and rule strings.

### 3. Put the key in PocketBase (collection API rules)

The key is stored in exactly one place on the server: the API rules of the `guestbook` collection. In the PocketBase admin UI, open **Collections, guestbook, API Rules**. Replace `YOUR_KEY` with the key from step 2.

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

### 4. Rate limiting, real client IPs and CORS

See "PocketBase setup" below. Do these before testing the rate limit.

### 5. Program the chips

Write four NFC URLs, one per ring, as a URL/URI record in an NFC writer app. Use the real hostname and key (kept outside this repo):

```
https://<napkinring-host>/#ring=1&key=YOUR_KEY
https://<napkinring-host>/#ring=2&key=YOUR_KEY
https://<napkinring-host>/#ring=3&key=YOUR_KEY
https://<napkinring-host>/#ring=4&key=YOUR_KEY
```

### 6. Test from the command line

Replace `YOUR_KEY` in each command with the real key. Avoid leaving the real key in shared shell history. Starting a command with a space hides it from history in many shells.

**List without the key.** Expect a rejection or an empty `"items":[]`. Check the body, not only the status.
```bash
curl -s -w "\nHTTP %{http_code}\n" "https://pocketbase.tail32217.ts.net/api/collections/guestbook/records"
```

**List with the key.** Expect HTTP 200 and your records.
```bash
curl -s -w "\nHTTP %{http_code}\n" -H "X-Napkin-Key: YOUR_KEY" "https://pocketbase.tail32217.ts.net/api/collections/guestbook/records"
```

**Create with the key and a valid ring.** Expect HTTP 200 and the new record as JSON.
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST "https://pocketbase.tail32217.ts.net/api/collections/guestbook/records" \
  -H "X-Napkin-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"guest_name":"Test Guest","date":"2026-10-30 12:00:00.000Z","comment":"curl test","dinner_rating":5,"ring":"1"}'
```

**Create without the key.** Expect a rejection (a 400-series status).
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST "https://pocketbase.tail32217.ts.net/api/collections/guestbook/records" \
  -H "Content-Type: application/json" \
  -d '{"guest_name":"No Key","date":"2026-10-30 12:00:00.000Z","ring":"1"}'
```

**Create with an invalid ring.** Expect a rejection.
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST "https://pocketbase.tail32217.ts.net/api/collections/guestbook/records" \
  -H "X-Napkin-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"guest_name":"Bad Ring","date":"2026-10-30 12:00:00.000Z","ring":"5"}'
```

**CORS preflight from the site.** Look for `Access-Control-Allow-Origin` and `x-napkin-key` in the allowed headers.
```bash
curl -s -i -X OPTIONS "https://pocketbase.tail32217.ts.net/api/collections/guestbook/records" \
  -H "Origin: https://napkinring.tail32217.ts.net" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: x-napkin-key,content-type"
```

**Rate limit.** Sends 10 rapid posts and prints one status per request. Expect 200s, then 429s once the limit is passed.
```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "https://pocketbase.tail32217.ts.net/api/collections/guestbook/records" \
    -H "X-Napkin-Key: YOUR_KEY" \
    -H "Content-Type: application/json" \
    -d '{"guest_name":"Rate Test","date":"2026-10-30 12:00:00.000Z","ring":"1"}'
done; echo
```

**Site reachable.** Also open the chip URL on a phone that is not on your tailnet.
```bash
curl -sI "https://napkinring.tail32217.ts.net" | head -n 1
```

Cleanup: the create and rate-limit tests make real records. Update and delete are locked, so remove them in the PocketBase admin UI.

Your own tests all come from one IP. To confirm limits are per guest through Funnel, also compare behavior from a phone on cellular.

---

## PocketBase setup (reference)

### Create the collection

New collection, type **Base**, named `guestbook`:

| Field | Type | Settings |
|---|---|---|
| guest_name | Text | Required, max length 80 |
| date | Date | Required |
| comment | Text | Optional, max length 1000 |
| dinner_rating | Number | Optional, min 1, max 5, integers only |
| ring | Text | Required |

PocketBase's built-in `created` field is kept for auditing. `date` is the user-facing, editable date. The API rules are in "Configuration after install", step 3.

### Rate limiting

Settings, then the rate limit section: enable it and set conservative limits. Suggested starting point is about 5 create requests per minute per IP, with looser limits on reads.

### Real client IPs behind Funnel

Behind Tailscale Funnel and the sidecar, PocketBase may see the proxy's address instead of each guest's. If so, every guest shares one rate-limit bucket. In Settings, configure the **trusted proxy headers** so PocketBase reads the real client IP. Test this after deploying.

### CORS

PocketBase's allowed origins are set at startup with the `--origins` flag, not in the admin UI. The default allows all origins. Restricting it to the site's hostname is optional hardening. Because the browser sends a custom header (`X-Napkin-Key`), the preflight request must be allowed to carry it.

---

## What failures look like

When a rule fails, PocketBase's response depends on the action. A failed create typically returns a 400-series error, while a failed list can return a normal 200 with zero results instead of an error. The front end therefore:

- treats any non-success response on a post as a failure and **never shows "thanks" unless the server confirmed the save**;
- distinguishes a rate-limit response (429) from other failures;
- shows "Could not reach the guest book" when the request never gets a response (wrong PocketBase address, or a CORS block).

A wrong key on a list request may show an empty list instead of an error. Confirm the real behavior with the tests above.

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

See `BuildSpec.md` for the full front-end and design specification.
