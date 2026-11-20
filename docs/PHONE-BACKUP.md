# Backing up a phone

## What this app can do

**Photos and videos: Home screen > Back up photos.** Pick photos and videos (the whole camera roll, or an album). They are copied to `My files > Camera backup > <year>`, originals unchanged. Run it whenever you like: files already there are skipped, and an interrupted run continues where it stopped. Keep the app open and the phone awake until it says "Backup finished" (the app asks the phone to stay awake). The second-bucket backup (docs/RESTORE.md) then protects those copies too.

## What no web app can do

- **Automatic background sync.** An installed web app cannot read the camera roll, contacts or messages in the background, or at all without you choosing the files. Only a native app, or a sync app that you install on the phone, can do that.
- **A full phone backup (apps, settings, contacts, messages, call history).** On a Pixel this is Android's own **Backup by Google One** (Settings > System > Backup), tied to your Google account. No other app, including this one, can read or replace it. Keep it turned on; it is your backup for app data, settings and the phone itself.

## Covering contacts, messages and call history yourself

These are exports you can drop into the app now and then (use the normal **Upload** button; it accepts any file type). They give you a copy outside Google, not an automatic one.

- **Contacts:** Contacts app > Fix & manage > Export to file (a `.vcf` file) > upload it.
- **Text messages and call history:** the free app *SMS Backup & Restore* can save messages and call logs as XML files, on a schedule, into a folder on the phone. Upload the new files from that folder every so often. (Check the app's current options; Android and the app change.)

## If you want it to run by itself

That needs a sync app on the phone (for example FolderSync on Android, or PhotoSync on iPhone and Android) uploading to an address this app does not have yet: a WebDAV endpoint with a per-person app password, reachable without the Cloudflare login. It is buildable, but it opens a public entry point in front of your files, so it deserves its own careful pass. iPhones also limit background work, so it would never be fully hands-off there.
