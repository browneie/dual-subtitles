# Dual Subtitles (Stremio addon)

Shows **two subtitle languages at once** (e.g. English on top, Chinese below) in Stremio.

Stremio's player can only show one subtitle track at a time. This addon gets subtitles for both
languages from OpenSubtitles, merges them line by line, and gives Stremio one combined track.

## Run it

1. Install **Node.js** (the "LTS" version) from https://nodejs.org if you don't have it. Nothing else is needed.
2. Start the addon:
   - **Mac:** double-click `start-mac.command`. The first time, macOS may block it: right-click it, choose **Open**, then **Open** again.
   - **Windows:** double-click `start-windows.bat`.
   - **Linux:** run `./start-linux.sh` in a terminal inside this folder (or double-click it, if your file manager runs scripts).
     If it says permission denied, run `chmod +x start-linux.sh` first. Node.js 18+ is needed: older distro packages may be too old, so check with `node -v`.
   - **Or from a terminal**, inside this folder: `node server.js`

A window opens saying the addon is running. Leave it open while you watch.

The setup page opens in your browser (or go to http://127.0.0.1:7000/). Pick your two languages and click **Copy addon URL**.
In Stremio, go to **Addons → + Add addon** and paste it (e.g. `http://127.0.0.1:7000/eng-zh/manifest.json`). Keep the `http://` and the `:7000`; the `stremio://` link style switches to https and drops the port, so it won't work with a local server.

Stremio talks to the addon every time you open a video, so it only works while that window is open.
Close the window (or press Ctrl+C in it) to stop it.

## Using it

In the player, open the subtitles menu. Under **Subtitles Languages** there's a new entry like
**"English + Chinese (any)"**. Up to 3 variants (different subtitle files) are listed under it, so if
one is out of sync, try another.

Want another pair? Install the addon again with different languages. Each pair is its own addon.

## Notes

- **Chinese (any)** matches Simplified, Traditional and bilingual Chinese files. OpenSubtitles' Chinese
  coverage is thin, so some titles have none.
- If one of the two files fails to download, the track shows the language that did load.
- If a bilingual file already includes the top language, the duplicate lines are removed.
- Timing comes from the top language. If the bottom file was made for a different release and is shifted,
  it's re-timed automatically. Each bottom line is attached to the top line it overlaps most.
- The server only listens on `127.0.0.1`, so it works with Stremio on the same computer. To use it from a
  TV or phone on your network, start it with `HOST=0.0.0.0 node server.js` and install it using your
  computer's LAN IP instead of 127.0.0.1.
- Change the port with `PORT=8000 node server.js`.
