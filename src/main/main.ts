'use strict';

import { app, BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions, shell } from 'electron';
import * as path from 'path';
import { format as formatUrl } from 'url';
import { initIPC } from './api';
import { checkUpdater } from './updater';
import { hideOrQuit } from './platform';
import { SYSTEM_IS_MACOS, NEW_ISSUE_PAGE, GITHUB_PROJECT_PAGE } from './const';
import { version } from '../../package.json';
import ua from 'universal-analytics';
import { CoreAPI } from '../renderer/core-api';
import { uuidv4 } from '../renderer/utils';
import os from 'os';

const isDevelopment = process.env.NODE_ENV !== 'production';

// global reference to mainWindow (necessary to prevent window from being garbage collected)
let mainWindow: BrowserWindow | null;

let appReady = false;

app.commandLine.appendSwitch('--no-proxy-server');

const timer = setInterval(async () => {
    const result = await checkUpdater();
    if (result) {
        clearInterval(timer);
    }
}, 1000 * 60 * 60);

if (process.argv.indexOf('--update') !== -1) {
    checkUpdater();
}

function createMainWindow() {
    const window = new BrowserWindow({
        height: 700,
        width: 1100,
        minHeight: 700,
        minWidth: 1100,
        webPreferences: {
            nodeIntegration: true,
        },
        // https://github.com/alibaba/lightproxy/issues/22
        // disable frameless in Windows
        frame: SYSTEM_IS_MACOS ? false : true,
    });

    if (isDevelopment) {
        window.webContents.openDevTools();
    }

    if (isDevelopment) {
        window.loadURL(`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}`);
    } else {
        window.loadURL(
            formatUrl({
                pathname: path.join(__dirname, 'index.html'),
                protocol: 'file',
                slashes: true,
            }),
        );
    }

    window.on('closed', () => {
        hideOrQuit();
    });

    window.webContents.on('devtools-opened', () => {
        window.focus();
        setImmediate(() => {
            window.focus();
        });
    });

    return window;
}

function setApplicationMenu() {
    const defaultMenu = Menu.getApplicationMenu();
    const applicationMenu = new Menu();

    (defaultMenu?.items ?? [])
        .filter(menu => {
            // remove the original help menu
            return menu.role !== 'help';
        })
        .forEach(menu => {
            if (menu.role === 'viewMenu') {
                const subMenu = new Menu();
                (menu.submenu?.items ?? []).forEach(item => subMenu.append(item));
                menu.submenu = subMenu;
                applicationMenu.append(
                    new MenuItem({
                        type: menu.type,
                        label: menu.label,
                        submenu: subMenu,
                    }),
                );
            } else {
                applicationMenu.append(menu);
            }
        });

    // append custom help menu
    const helpSubMenu = new Menu();
    const helpSubMenuConfig: MenuItemConstructorOptions[] = [
        {
            label: 'Project Homepage',
            click: function() {
                shell.openExternal(GITHUB_PROJECT_PAGE);
            },
        },
        {
            label: 'Report Issue',
            click: function() {
                shell.openExternal(NEW_ISSUE_PAGE);
            },
        },
    ];
    helpSubMenuConfig.forEach(option => {
        helpSubMenu.append(new MenuItem(option));
    });
    applicationMenu.append(
        new MenuItem({
            label: 'Help',
            type: 'submenu',
            submenu: helpSubMenu,
        }),
    );

    Menu.setApplicationMenu(applicationMenu);
}

// quit application when all windows are closed
app.on('window-all-closed', () => {
    // on macOS it is common for applications to stay open until the user explicitly quits
    if (SYSTEM_IS_MACOS) {
        app.quit();
    }
});

app.on('activate', () => {
    if (!appReady) {
        // fix `Cannot create BrowserWindow before app is ready`
        return;
    }
    // on macOS it is common to re-create a window even after all windows have been closed
    if (!mainWindow) {
        mainWindow = createMainWindow();
    }
    mainWindow.show();
});

// create main BrowserWindow when electron is ready
app.on('ready', () => {
    appReady = true;
    mainWindow = createMainWindow();
    setApplicationMenu();
    initIPC();

    if (!CoreAPI.store.get('userid')) {
        CoreAPI.store.set('userid', uuidv4());
    }

    const userid = CoreAPI.store.get('userid');

    const visitor = ua('UA-154996514-1', userid);

    visitor.set('app-version', version);
    visitor.set('os', os.type());
    visitor.set('os-version', os.release());
    visitor.set('electron-version', process.versions.electron);
    visitor
        .pageview('/', err => {
            console.error(err);
        })
        .send();

    setInterval(() => {
        visitor.pageview('/').send();
    }, 1000 * 60 * 30);
});
