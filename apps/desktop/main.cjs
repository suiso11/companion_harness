// Desktop pet shell: a frameless, transparent, always-on-top window showing
// the harness' `/pet` page. The page owns the avatar; this process owns only
// the OS window, the tray, and bounds persistence. Requires Electron
// (dev-only dependency) and a compositor for transparency.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  screen,
  session,
} = require("electron");
const { pickBounds } = require("./bounds.cjs");

const base = (process.env.COMPANION_PET_URL || "http://127.0.0.1:3000").replace(
  /\/+$/,
  "",
);
const smoke = process.env.COMPANION_PET_SMOKE === "1";
const smokeOut =
  process.env.COMPANION_PET_SMOKE_OUT || "/tmp/companion-pet-smoke.png";
// 16x16 rose disc: a tray icon must exist, and no binary assets live here.
const ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR42mNgGJTgTsW0/9gw2RqJNogiA4jVjNOQUQOoYMDApwOqJOUBAQANMWjsr1JiKQAAAABJRU5ErkJggg==";

let win;
let tray;
let quitting = false;
let saveTimer;

function stateFile() {
  return path.join(app.getPath("userData"), "pet-window.json");
}

function loadBounds() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
  return pickBounds(
    saved,
    screen.getAllDisplays().map((display) => display.workArea),
  );
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
    } catch {
      // A read-only profile keeps the default position; never fatal.
    }
  }, 500);
}

function createWindow() {
  win = new BrowserWindow({
    width: 360,
    height: 560,
    ...loadBounds(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.on("move", saveSoon);
  win.on("resize", saveSoon);
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  // Unreachable server: say so instead of showing a blank window.
  win.webContents.on("did-fail-load", () => {
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<body style="background:#111;color:#eee;font:14px sans-serif;padding:16px">` +
            `Companion サーバに接続できません<br>${base}<br>` +
            `サーバを起動してから、トレイの「表示」を選んでください。</body>`,
        ),
    );
  });
  void win.loadURL(`${base}/pet`);

  if (smoke) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        if (!win.webContents.getURL().startsWith(base)) {
          console.error("pet smoke: page did not load from " + base);
          app.exit(1);
          return;
        }
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        fs.writeFileSync(smokeOut, png);
        const size = image.getSize();
        console.log(
          JSON.stringify({
            alwaysOnTop: win.isAlwaysOnTop(),
            bounds: win.getBounds(),
            bytes: png.length,
            pngWidth: size.width,
            pngHeight: size.height,
          }),
        );
        app.exit(0);
      }, 2500),
    );
  }
}

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(ICON));
  tray.setToolTip("Companion");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "表示",
        click: () => {
          // The error page cannot recover by itself; reload the pet page.
          if (win.webContents.getURL().startsWith("data:")) {
            void win.loadURL(`${base}/pet`);
          }
          win.show();
        },
      },
      { label: "隠す", click: () => win.hide() },
      {
        label: "マウスを透過",
        type: "checkbox",
        checked: false,
        click: (item) =>
          win.setIgnoreMouseEvents(
            item.checked,
            item.checked ? { forward: true } : undefined,
          ),
      },
      {
        label: "常に手前に固定",
        type: "checkbox",
        checked: true,
        click: (item) => win.setAlwaysOnTop(item.checked, "screen-saver"),
      },
      { type: "separator" },
      { label: "終了", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => win.show());
}

app.on("before-quit", () => {
  quitting = true;
});
app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  // /pet renders the avatar only; never grant camera/microphone to a page.
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, cb) => cb(false),
  );
  createWindow();
  createTray();
});
