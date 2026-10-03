# Shared file portal

A small website that runs on one Windows computer and stores the files on that computer. Other computers on the same local network open it in a browser. Nothing is uploaded to a cloud service, and the portal does not need an internet connection after it is installed.

With `OPEN_ACCESS=1` in `.env`, the site opens without a username or password. Anyone who can reach it can browse, upload, and download. Files uploaded in that mode belong to one shared account, so anyone can delete those. Set `OPEN_ACCESS` empty to require a username and password again. Only the person who uploaded a file can delete it.

Each file can be up to **2 GB**. The portal holds up to **50 GB** in total. Both limits are set in `.env`.

Sharing links are not part of this version. A direct send can move a file between two open browsers on this network when the uploader still has it from this visit. The copy stored here remains, and Download still uses that copy. Uploading a file again adds another file. Replace, on a file you uploaded, keeps the previous bytes as an earlier version, and those bytes still count toward the storage limit. A deleted file stays in your bin for 30 days and still counts toward the storage limit. Images within 8 MB and plain text can be previewed in the page. HTML, SVG, and other types are downloaded and are not shown as part of the site. Files can be organized in shared folders, tagged, and grouped into collections. A star is personal to the person who set it. A folder can be chosen when the browser allows it; otherwise choose the files. An upload can continue after it stops, for 24 hours, when the same file is chosen again.

## How it is put together

The browser talks to this computer for the website, the stored files, and the short messages that set up a direct send. The file bytes of a direct send go from one browser to the other on the local network. They are not fetched from this computer and forwarded. One Node.js process serves the website and the API. Files are streamed to and from a folder on disk. Names, owners, and sizes live in a SQLite database next to that folder. The website files that the server sends are the built React app. They are not loaded from a public CDN.

```
browser on another PC
        |
        |  HTTPS on the LAN (HTTP only while developing on this PC)
        v
Express on this Windows PC
   |-- session cookie + CSRF header
   |-- SQLite database (users, sessions, file records, unfinished uploads)
   `-- storage folder (one generated id per file, including a saved partial)
```

A file appears in the list only after the upload finishes and the size is checked. The browser sends the file in parts of up to 8 MB. Each part is written to a temporary file and saved only after that part is complete. The full size is reserved as soon as the upload starts, so an unfinished upload counts toward the 50 GB limit. When the last part arrives, the file is moved into place and marked ready.

Saved progress is kept for 24 hours. It is not a backup. After a reload, the browser cannot remember which file was selected, so the same file has to be chosen again. The portal checks the name and size only. Two different files with the same name and size cannot be told apart. Cancel removes the saved progress.

If the process stops in the middle:

- A part that was cut off is discarded. The last complete part remains, and the upload can continue until it expires.
- An unfinished upload older than 24 hours is deleted the next time the server starts. It is not listed.
- A file that was fully written but not yet marked ready is published on the next start, when its size matches the database.
- A database row whose file is missing, or whose size does not match, is removed.
- A file on disk with no database row is removed.
- Finished files and accounts stay available after a restart. Sessions are in the same database, so a person who was signed in can stay signed in until the session expires.

Uploaded files are stored by a generated id. The original filename is kept in the database and shown in the browser. It is never used as a folder path. Downloads are sent as attachments with a generic file type, so the browser saves them instead of showing uploaded HTML as part of this site.

## What you need

- Windows 10 or 11
- Node.js 24, including npm. The server uses Node’s built-in SQLite
- This project folder
- No extra database server and no cloud account

Check the install:

```powershell
node -v
npm -v
```

`node -v` should print v24 or newer.

## First-time setup on this computer

Open PowerShell and go to the project folder. The examples below use `C:\Users\USER\Downloads\Connect`. Use your own path.

```powershell
cd C:\Users\USER\Downloads\Connect
npm install
Copy-Item .env.example .env
```

Create a session secret and paste it into `.env` as `SESSION_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Leave `HOST=127.0.0.1` until you are ready for other computers. Build the site, create the first account, and start it:

```powershell
npm run build
$env:PORTAL_NEW_PASSWORD = Read-Host "Password for the new user"
npm run create-user -- ada
Remove-Item Env:PORTAL_NEW_PASSWORD
npm start
```

Passwords must be 8 to 72 characters. The password is not printed back. Usernames are 3 to 32 characters: letters, numbers, periods, underscores, and hyphens.

Open `http://127.0.0.1:3000` on this same computer and sign in. This address does not work from another computer. That is intentional.

Create more people the same way, with a different username. You can do that while the server is running.

## Development on this computer

`npm run dev` starts the API at `http://127.0.0.1:3000` and the website at `http://127.0.0.1:5173`. Use the 5173 address while developing. It still talks only to this PC, and it does not use HTTPS. Do not point other computers at the dev server.

`npm start` is the mode to use once the site is built. It serves the website and the API on one port.

## Let another computer on the LAN open it

Do this only after sign-in works on this PC.

### 1. Find this computer’s LAN address and MAC address

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" } |
  Select-Object InterfaceAlias, IPAddress

Get-NetAdapter | Where-Object Status -eq "Up" | Select-Object Name, MacAddress
```

Use the address on your home or office network, often `192.168.x.x` or `10.x.x.x`. The other computer will use that address. `127.0.0.1` always means “this computer,” so it will not work from a laptop across the room.

Example: if this PC’s address is `192.168.1.50`, the other computer opens `https://192.168.1.50:8443`.

### 2. Keep that address from changing

Home routers give out addresses with DHCP, and a reboot can give this PC a new one. A DHCP reservation tells the router “this MAC address always gets this IP address.”

In the router’s admin page, look for DHCP reservation, “static lease,” or “address reservation.” Enter the MAC address from the command above and the IP address you want to keep, such as `192.168.1.50`. Save it, then renew the PC’s address or reboot it and check `Get-NetIPAddress` again.

This is a setting on the router for your own LAN. It is not a port forward, and it does not expose the portal to the internet.

### 3. Create an HTTPS certificate

Other computers must use HTTPS. The server will refuse to listen on a network address without a certificate.

Run this on the server PC, with the LAN address you just chose:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\new-certificate.ps1 -LanIp 192.168.1.50
```

The script writes:

- `data\certs\portal.pfx` — the private key. Leave it on this PC only.
- `data\certs\portal.cer` — the public certificate. Copy this file to the other computers.

Edit `.env`:

```text
HOST=0.0.0.0
PORT=8443
HTTPS_PFX_PATH=data/certs/portal.pfx
HTTPS_PFX_PASSPHRASE=the-passphrase-you-typed
SESSION_SECRET=the-secret-you-generated
```

`HOST=0.0.0.0` means “accept connections on this PC’s network cards.” It does not by itself allow the internet in. Your router still has to block unsolicited inbound traffic, which it does unless someone turns on port forwarding. Do not forward port 8443.

Trust the certificate on the server PC so its own browser stops warning you:

```powershell
Import-Certificate -FilePath .\data\certs\portal.cer -CertStoreLocation Cert:\CurrentUser\Root
```

Windows will ask you to confirm. Copy `portal.cer` to each other computer (a USB stick is fine) and run that same import there, in that person’s Windows account. Do not copy `portal.pfx`.

If a browser says the certificate is untrusted or the name does not match, stop and fix the certificate. Do not use “continue anyway.” A warning means the browser cannot tell this server from an impostor on the network.

Then rebuild is unnecessary for a config change. Start the server again:

```powershell
npm start
```

On the other computer, open `https://192.168.1.50:8443` (your address and port). Sign in with an account you created.

### 4. Allow the port through Windows Firewall, privately

The first time Node listens, Windows may ask whether to allow it. Choose private networks only.

Or add a single rule yourself. Open PowerShell as Administrator:

```powershell
cd C:\Users\USER\Downloads\Connect
powershell -ExecutionPolicy Bypass -File .\scripts\allow-private-lan.ps1
```

That rule allows inbound TCP on the port in `.env`, and only while the network is classified as Private. Check the classification:

```powershell
Get-NetConnectionProfile
```

A home or office LAN should be Private. A cafe, hotel, or guest Wi-Fi should stay Public. The rule does not apply on Public networks, and that is what you want.

Do not turn the firewall off. Do not create an “any port” rule. Do not add this port to the router’s port-forwarding page.

### 5. Start it again after Windows restarts

The portal runs in the signed-in user’s account so it can read the storage folder. This task starts it about 30 seconds after that user signs in:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-logon-task.ps1
```

Sign in after a reboot, or leave that account signed in on a computer you use as the server. The task does not run as SYSTEM, and it does not start while the user is signed out.

Remove it later with:

```powershell
Unregister-ScheduledTask -TaskName SharedFilePortal -Confirm:$false
```

You can also start it by hand with `.\scripts\start-portal.ps1`.

## Settings

| Setting | Meaning |
| --- | --- |
| `HOST` | `127.0.0.1` for this PC only. `0.0.0.0` when other computers on the LAN should connect. |
| `PORT` | `3000` for local development. `8443` is a sensible LAN port. |
| `STORAGE_DIR` | Folder that holds the files. Keep it outside the website folders. |
| `DATABASE_PATH` | SQLite file for accounts, sessions, and file records. |
| `MAX_FILE_BYTES` | Per-file limit. Default `2147483648` (2 GB). |
| `MAX_STORAGE_BYTES` | Total finished and in-progress files. Default `53687091200` (50 GB). |
| `SESSION_SECRET` | Long random string. Required before other computers connect. |
| `OPEN_ACCESS` | `1` opens the file list with no username or password. Leave it empty to require sign-in. |
| `SESSION_TTL_HOURS` | How long a sign-in lasts. Default 12. |
| `HTTPS_PFX_PATH` / `HTTPS_PFX_PASSPHRASE` | Certificate for LAN use. |
| `HTTPS_KEY_PATH` / `HTTPS_CERT_PATH` | Use these instead of a PFX if you already have a PEM key and certificate. |

Paths in `.env` can be relative to the project folder or full Windows paths. Do not commit `.env`, the certificate, or the `data` folder.

## Commands

```powershell
npm install
npm run build
npm start
npm test
npm run dev
npm run create-user -- username
```

`npm test` runs the automated checks. It does not need the server to be started first.

## Using the website

1. Open the site. With `OPEN_ACCESS=1`, the file list appears immediately. With that line empty, sign in with an account created on this PC.
2. Drop files onto the page, choose files, or choose a folder when the browser offers that. A folder from your computer is recreated under the folder you have open. If the browser cannot pick a folder, choose the files instead. A path that tries to climb out with `..` stays inside the open folder. The transfer list shows waiting, active, finished, canceled, and failed files. An active file shows how much has been sent, the recent speed, and an estimate of the time left. If the transfer stops making progress, the row says it is stalled. Cancel removes that upload, including any part already saved. Retry continues from the last saved part when the upload is still on the server. You can run 1, 2, or 3 uploads at once; the server still enforces its own cap. Leaving or reloading the page stops the browser’s current transfer. Choose the same file again to continue. Saved progress stays for 24 hours. The page cannot resume a file by itself after a reload.
3. Create a folder and open it from the breadcrumb trail. A new upload goes into the folder you have open. Anyone signed in can open every folder. Only the person who created a folder can rename it, and can delete it when it is empty. Search still looks through every folder. Sort by name, size, or date. Switch between the list and the grid. The file list is loaded one page at a time.
4. Select files to move them into the open folder, delete them, download them as one zip, tag them, or add them to a collection. Move and delete apply only to files you uploaded. A zip can include any selected file, because anyone signed in can already download it. Up to 100 files at a time. A single download still uses the browser’s own download, and the page does not show download progress.
5. Star a file to keep it in your own Favorites list. Anyone signed in can add or remove a tag, and can add or remove a file from a collection. Only the person who created a collection can rename or delete it. Deleting a collection leaves the files in place. Favorites, a tag, and a collection each look through every folder.
6. Replace is offered only for a file you uploaded. The previous bytes stay available as an earlier version until you remove that version or the file leaves the portal. Uploading the same name again does not replace anything. Preview is offered for a picture within 8 MB and for a text file. The picture also appears as a thumbnail. A text preview shows at most the first 256 KB. HTML and SVG stay as downloads, so a page or script in the portal cannot run. PDF, audio, and video stay as downloads. Delete is offered only for files you uploaded. The server checks that again; hiding the button is not the only check. Delete moves the file to your bin for 30 days. Restore puts it back in the same folder, or at the top level if that folder was deleted. Delete permanently removes it. The bin still counts toward the 50 GB limit. Another person cannot see or restore your bin.
7. Direct appears on someone else’s file when that person has the portal open. It asks their browser to send the file straight to yours. That works only for a file they uploaded during this visit, before they reload, and only up to 256 MB. Otherwise use Download. The direct path uses this computer only to pass the connection details. It does not use a public address-lookup service, so it stays on the local network. Download always uses the copy stored on this computer.
8. The bar at the top shows how much of the 50 GB is in use, including unfinished uploads, the bin, and earlier versions.

An empty list, a loading line, a success note, and the server’s error text are shown on the page. A file that is too large, a full portal, a full disk, or a lost connection is reported as a failed upload and is not added to the list.

## API

All `/api` routes require a signed-in session except `POST /api/auth/login`.

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Body `{ "username", "password" }`. Sets an HttpOnly session cookie. |
| `POST` | `/api/auth/logout` | Ends the session. Requires the `X-CSRF-Token` header. |
| `GET` | `/api/auth/me` | Current person, CSRF token, size limits, and upload caps. |
| `GET` | `/api/files?q=&sort=name\|size\|date&order=asc\|desc&folderId=&cursor=&limit=&favorite=&tagId=&collectionId=` | Files in one folder, plus its subfolders, breadcrumbs, and the next page. A search, Favorites, a tag, or a collection looks through every folder. Each file includes `favorite` for the signed-in person and the shared `tags`. `limit` is 1 to 100 and defaults to 50. |
| `POST` | `/api/folders` | Creates a shared folder. Body `{ "name", "parentId" }`. Requires `X-CSRF-Token`. |
| `POST` | `/api/folders/ensure` | Creates any missing folders in a relative path. Body `{ "path", "parentId" }`. Requires `X-CSRF-Token`. |
| `POST` | `/api/files/move` | Moves files you uploaded. Body `{ "ids", "folderId" }`. `folderId` may be null for the top level. Requires `X-CSRF-Token`. |
| `POST` | `/api/files/delete-many` | Deletes files you uploaded. Body `{ "ids" }`. Files you did not upload are left in place. Requires `X-CSRF-Token`. |
| `GET` | `/api/files/zip?ids=` | Streams the chosen files as one zip. At most 100 ids. |
| `PATCH` | `/api/folders/:id` | Renames a folder the signed-in person created. Requires `X-CSRF-Token`. |
| `DELETE` | `/api/folders/:id` | Deletes an empty folder the signed-in person created. Requires `X-CSRF-Token`. |
| `POST` | `/api/uploads` | Starts an upload. Body `{ "originalName", "sizeBytes", "folderId" }`. `folderId` may be omitted for the top level. An empty file is published immediately. Requires `X-CSRF-Token`. |
| `GET` | `/api/uploads` | Unfinished uploads for the signed-in person, and the part size. |
| `PATCH` | `/api/uploads/:id` | Appends one part. Raw `application/octet-stream`, with `Upload-Offset` and `Content-Length`. Requires `X-CSRF-Token`. |
| `DELETE` | `/api/uploads/:id` | Cancels an unfinished upload owned by the signed-in person. Requires `X-CSRF-Token`. |
| `POST` | `/api/files` | One-shot multipart upload, field name `file`. Requires `X-CSRF-Token`. |
| `GET` | `/api/tags` | Shared tags. |
| `POST` | `/api/files/tags` | Adds one tag to up to 100 files. Body `{ "ids", "name" }`. Requires `X-CSRF-Token`. |
| `DELETE` | `/api/files/:id/tags/:tagId` | Removes a shared tag from a file. Requires `X-CSRF-Token`. |
| `POST` | `/api/files/:id/favorite` | Adds the file to the signed-in person’s favorites. Requires `X-CSRF-Token`. |
| `DELETE` | `/api/files/:id/favorite` | Removes the file from the signed-in person’s favorites. Requires `X-CSRF-Token`. |
| `GET` | `/api/collections` | Shared collections. `canRename` and `canDelete` are true for the person who created one. |
| `POST` | `/api/collections` | Creates a collection. Body `{ "name" }`. Requires `X-CSRF-Token`. |
| `PATCH` | `/api/collections/:id` | Renames a collection the signed-in person created. Requires `X-CSRF-Token`. |
| `DELETE` | `/api/collections/:id` | Deletes a collection the signed-in person created. The files stay. Requires `X-CSRF-Token`. |
| `POST` | `/api/collections/:id/files` | Adds up to 100 files to a collection. Body `{ "ids" }`. Requires `X-CSRF-Token`. |
| `DELETE` | `/api/collections/:id/files/:fileId` | Removes a file from a collection. Requires `X-CSRF-Token`. |
| `GET` | `/api/files/:id/preview` | Image or plain text for a signed-in person. HTML and other types are refused. A long text file is cut off at 256 KB. |
| `GET` | `/api/files/:id/thumbnail` | A picture for a signed-in person, only when the file is an image of 8 MB or less. A generated thumbnail is used when `ffmpeg` is installed. Otherwise the original image is sent. |
| `GET` | `/api/files/:id/download` | Streams the file as a download. |
| `POST` | `/api/files/:id/replace` | Replaces a file the signed-in person uploaded. The previous bytes become an earlier version. Multipart field `file`. Requires `X-CSRF-Token`. |
| `GET` | `/api/files/:id/versions` | Earlier versions of a file that is still in the portal. |
| `GET` | `/api/files/:id/versions/:versionId/download` | Downloads one earlier version. |
| `DELETE` | `/api/files/:id/versions/:versionId` | Removes an earlier version of a file the signed-in person uploaded. Requires `X-CSRF-Token`. |
| `GET` | `/api/bin` | Files the signed-in person deleted. They remain for 30 days. |
| `POST` | `/api/files/:id/restore` | Puts one of those files back. Requires `X-CSRF-Token`. |
| `DELETE` | `/api/files/:id/permanent` | Removes a binned file and its stored bytes. Requires `X-CSRF-Token`. |
| `DELETE` | `/api/files/:id` | Moves a file the signed-in person uploaded into the bin. Requires `X-CSRF-Token`. |
| `POST` | `/api/peers/heartbeat` | Marks the signed-in person as present for about 20 seconds. Requires `X-CSRF-Token`. |
| `GET` | `/api/peers` | User ids of people who are present. It does not include addresses. |
| `POST` | `/api/signals` | Passes one direct-send message (`request`, `offer`, `answer`, `ice`, or `reject`). The body is connection data, never file bytes. A request goes to the uploader, and only the two people in that transfer can continue it. Requires `X-CSRF-Token`. |
| `GET` | `/api/signals` | Takes the signed-in person’s waiting direct-send messages. |

The cookie is `HttpOnly` and `SameSite=Strict`. On HTTPS it is also `Secure`. State-changing requests must send the CSRF token from the login or session response.

## Database

```sql
users (id, username, password_hash, created_at)
sessions (sid, sess, expired)
files (id, owner_id, original_name, size_bytes, created_at, state, folder_id, deleted_at)
upload_sessions (id, owner_id, original_name, size_bytes, received_bytes, created_at, updated_at, expires_at, folder_id)
folders (id, parent_id, name, created_by, created_at)
tags (id, name, created_by, created_at)
file_tags (file_id, tag_id, created_by, created_at)
favorites (user_id, file_id, created_at)
collections (id, name, created_by, created_at)
collection_files (collection_id, file_id, added_by, created_at)
file_versions (id, file_id, original_name, size_bytes, created_at)
```

`files.folder_id` is empty at the top level. Folder names, tag names, and collection names are display names. They are never used as a directory on disk. A favorite row belongs to one person. Tags and collections are visible to everyone who is signed in. Thumbnail files, when `ffmpeg` creates them, live under `thumbs` and are removed with the file. They are not a second copy you can download by name.

`state` is `staging` while a finished upload is being published, then `ready`. The list and downloads only use `ready` files whose `deleted_at` is empty. A binned file keeps `deleted_at` and still counts toward the storage limit until it is restored, removed, or 30 days have passed. Earlier versions are separate stored files and count toward the same limit until they are removed or the file is removed. Passwords are stored as bcrypt hashes. Session cookies and passwords are not written to the log.

## Tests

```powershell
npm test
```

The automated tests cover sign-in, anonymous requests, upload, list, search, sort, download, duplicate names, empty files, Unicode names, Windows device names such as `con.txt`, path-style filenames, HTML forced to download, uploader-only deletion, CSRF, size and storage limits, repeated bad passwords, upload concurrency, a simulated full disk, a storage path that is not a folder, restart, crash cleanup, an aborted upload, a streamed multi-megabyte file, creating a user from the command line, resumable uploads, shared folders, and paged lists. Folder checks cover a name that looks like a path, a duplicate name, another person’s rename, an empty delete, a folder that still has a file, uploading into a folder, and a second page. Bulk checks cover moving and deleting only your own files, a zip of a shared file, and a folder path that tries to climb out. Catalog checks cover a personal favorite, a shared tag that disappears when unused, a collection another person can fill but cannot rename or delete, and a file delete that drops those links. Preview checks cover an image, plain text that contains HTML markup, a refused HTML file, a refused SVG file, a text file with a null byte, a truncated text preview, an image over 8 MB, and a thumbnail queue of eight jobs. Bin checks cover a personal bin, a restore, another person’s refusal, storage that still counts, and removal after 30 days. Version checks cover a same-name upload staying a separate file, a replace keeping the previous bytes, another person’s download, a refused replace when storage is full, and removing one version. Direct-send checks cover an anonymous request, a missing CSRF token, presence, a request sent to someone other than the uploader, an uploader who is not here, an offer from the receiver, a message delivered only to the other person, an outsider, an oversized message, and a missing file. They do not open a WebRTC connection.

The transfer list, folder buttons, list and grid switch, file checkboxes, folder picker, stars, tag chips, collection controls, preview dialog, bin, replace control, and Direct button were not clicked in a browser, and they were not tried from a second computer.

They do not fill a real disk, and they do not open a second physical computer. Trying the site from another computer on your LAN is a manual check: trust `portal.cer` there, open `https://<this-pc-lan-ip>:8443`, sign in, upload a file, and download it back.

## Layout

```text
client/     React website
server/     API, database, and file storage
scripts/    Certificate, firewall, startup, and sign-in task
data/       Created locally for the database, files, and certificate. Not part of the source.
```

## Troubleshooting

- **Other computers cannot connect.** Use the LAN IP, not `127.0.0.1`. Check `HOST=0.0.0.0`, that the server is running, and that the firewall rule is for the Private profile. Confirm both computers are on the same network.
- **The address worked yesterday and not today.** The DHCP address changed. Add the reservation described above.
- **The browser warns about the certificate.** Import `portal.cer` into Trusted Root Certification Authorities for the user who is browsing. The address in the browser must be the IP or name you put in the certificate.
- **Port already in use.** Change `PORT` in `.env`, or stop the other program.
- **The server cannot write files.** `STORAGE_DIR` must be a folder this Windows user can write to. The default is `data\storage` inside the project.
- **A large upload fails on a slow Wi-Fi link.** The server allows a long upload, up to two hours. The per-file limit is still 2 GB.
- **Direct does nothing or says the uploader is not here.** Both people need the portal open on this network. The uploader must have added that file during this visit and must not have reloaded. Files already stored, files over 256 MB, and a person who has left still use Download.
