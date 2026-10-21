// Runs after electron-builder has laid the app out: gives Eya.exe its own icon and details (so Task Manager, the taskbar and the
// installer say "Eya", not "Electron"). electron-builder normally does this with code-signing tools it downloads, but those cannot be
// unpacked on every Windows setup (they contain macOS symbolic links) and there is no signing certificate to use anyway, so that step
// is turned off ("signAndEditExecutable": false) and the same edit is done here with `rcedit`.
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { default: rcedit } = await import('rcedit');
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const info = context.packager.appInfo;
  await rcedit(exe, {
    icon: path.join(context.packager.projectDir, 'build', 'icon.ico'),
    'version-string': {
      ProductName: info.productName,
      FileDescription: `${info.productName} - your laptop assistant`,
      CompanyName: '',
      LegalCopyright: info.copyright ?? '',
      OriginalFilename: `${info.productFilename}.exe`,
      InternalName: info.productFilename,
    },
    'file-version': info.version,
    'product-version': info.version,
  });
  console.log(`  • set the icon and details on ${path.basename(exe)}`);
};
