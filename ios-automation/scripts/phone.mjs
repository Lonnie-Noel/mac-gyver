import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = 'http://127.0.0.1:4723';
const sessionFile = path.join(root, 'artifacts', 'active-session.json');

export async function request(method, route, body) {
  const response = await fetch(`${server}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  const data = await response.json();
  if (!response.ok || data.value?.error) throw new Error(JSON.stringify(data.value));
  return data.value;
}

export async function getSession() {
  return JSON.parse(await readFile(sessionFile, 'utf8')).sessionId;
}

export async function command(session, method, route, body) {
  return request(method, `/session/${session}${route}`, body);
}

export async function mobile(session, script, args = {}) {
  return command(session, 'POST', '/execute/sync', { script: `mobile: ${script}`, args: [args] });
}

export async function snapshot(session, destination) {
  return snapshotFiles(session, {
    source: path.join(destination, 'source.xml'),
    screenshot: path.join(destination, 'screen.png'),
  });
}

export async function snapshotFiles(session, files) {
  await mkdir(path.dirname(files.source), { recursive: true });
  await mkdir(path.dirname(files.screenshot), { recursive: true });
  const source = await command(session, 'GET', '/source');
  await writeFile(files.source, source);
  const png = await command(session, 'GET', '/screenshot');
  await writeFile(files.screenshot, Buffer.from(png, 'base64'));
  return files;
}

export async function findElements(session, using, value) {
  return command(session, 'POST', '/elements', { using, value });
}

export async function tapName(session, value) {
  const elements = await findElements(session, 'accessibility id', value);
  if (elements.length !== 1) throw new Error(`Expected exactly one ${value}; found ${elements.length}`);
  const id = elements[0]['element-6066-11e4-a52e-4f735466cecf'];
  await command(session, 'POST', `/element/${id}/click`, {});
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'start') {
    if (existsSync(sessionFile)) throw new Error('Active session file exists. Close or inspect it first.');
    process.loadEnvFile(path.join(root, '.env'));
    for (const key of ['IOS_UDID', 'IOS_TEAM_ID', 'WDA_BUNDLE_ID']) {
      if (!process.env[key]) throw new Error(`Missing ${key}`);
    }
    const value = await request('POST', '/session', { capabilities: { alwaysMatch: {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': process.env.IOS_UDID,
      'appium:xcodeOrgId': process.env.IOS_TEAM_ID,
      'appium:xcodeSigningId': 'Apple Development',
      'appium:updatedWDABundleId': process.env.WDA_BUNDLE_ID,
      'appium:allowProvisioningDeviceRegistration': true,
      'appium:derivedDataPath': path.join(root, 'DerivedData'),
      'appium:bundleId': 'com.apple.mobileslideshow',
      'appium:autoLaunch': false,
      'appium:noReset': true,
      'appium:shouldTerminateApp': false,
      'appium:useNewWDA': false,
      'appium:showXcodeLog': true,
      'appium:wdaStartupRetries': 1,
      'appium:wdaLaunchTimeout': 120_000,
      'appium:wdaConnectionTimeout': 30_000,
      'appium:newCommandTimeout': 1800,
    } } });
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, `${JSON.stringify({ sessionId: value.sessionId, createdAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(JSON.stringify({ sessionId: value.sessionId }));
    return;
  }
  const session = await getSession();
  if (action === 'snapshot') {
    if (!/^[a-zA-Z0-9_-]+$/.test(args[0] ?? '')) throw new Error('Provide a simple snapshot name.');
    console.log(JSON.stringify(await snapshot(session, path.join(root, 'artifacts', 'inspect', args[0]))));
  } else if (action === 'tap') {
    await tapName(session, args[0]);
    console.log(`Tapped ${args[0]}`);
  } else if (action === 'mobile') {
    console.log(JSON.stringify(await mobile(session, args[0], JSON.parse(args[1] ?? '{}'))));
  } else if (action === 'rect') {
    console.log(JSON.stringify(await command(session, 'GET', '/window/rect')));
  } else if (action === 'end') {
    await request('DELETE', `/session/${session}`);
    await unlink(sessionFile);
    console.log('Session closed');
  } else throw new Error('Use start | snapshot NAME | tap LABEL | mobile COMMAND JSON | rect | end');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
