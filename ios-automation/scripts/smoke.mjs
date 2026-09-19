import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const server = 'http://127.0.0.1:4723';

function readConfig() {
  const envFile = path.join(projectDir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const requirements = {
    IOS_UDID: /^(?:[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16}|[A-Fa-f0-9]{40})$/,
    IOS_TEAM_ID: /^[A-Z0-9]{10}$/,
    WDA_BUNDLE_ID: /^(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z0-9][A-Za-z0-9-]*$/,
  };
  const config = {};
  const problems = [];
  for (const [name, pattern] of Object.entries(requirements)) {
    const value = (process.env[name] ?? '').trim();
    if (!value) problems.push(`${name}: .env 또는 환경 변수에 값을 입력하세요.`);
    else if (!pattern.test(value)) problems.push(`${name}: 형식이 올바르지 않습니다.`);
    config[name] = value;
  }
  if (config.WDA_BUNDLE_ID?.endsWith('.xctrunner')) {
    problems.push('WDA_BUNDLE_ID: 자동으로 붙는 .xctrunner 접미사는 제외하세요.');
  }
  if (process.env.IOS_EXPORT_BUNDLE_ID?.trim()
    && (!requirements.WDA_BUNDLE_ID.test(process.env.IOS_EXPORT_BUNDLE_ID.trim())
      || process.env.IOS_EXPORT_BUNDLE_ID.trim().endsWith('.xctrunner'))) {
    problems.push('IOS_EXPORT_BUNDLE_ID: 사진 내보내기 보조 앱의 Bundle Identifier를 입력하세요.');
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return config;
}

async function verifyServer() {
  let response;
  try {
    response = await fetch(`${server}/status`, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(`Appium 서버에 연결할 수 없습니다. 다른 터미널에서 npm start를 실행하세요. (${error.message})`);
  }
  if (!response.ok) throw new Error(`Appium 상태 확인 실패: HTTP ${response.status}`);
  const body = await response.json();
  if (body.value?.ready !== true) throw new Error('Appium 서버가 새 세션을 받을 준비가 되지 않았습니다.');
}

async function smoke(config) {
  const startedAt = new Date().toISOString();
  const artifactDir = path.join(projectDir, 'artifacts', startedAt.replace(/[:.]/g, '-'));
  await mkdir(artifactDir, { recursive: true });
  const result = { status: 'running', startedAt, server, artifacts: {} };
  let driver;
  let failure;

  try {
    await verifyServer();
    const { remote } = await import('webdriverio');
    driver = await remote({
      protocol: 'http',
      hostname: '127.0.0.1',
      port: 4723,
      path: '/',
      logLevel: 'warn',
      connectionRetryCount: 0,
      connectionRetryTimeout: 600_000,
      capabilities: {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:udid': config.IOS_UDID,
        'appium:xcodeOrgId': config.IOS_TEAM_ID,
        'appium:xcodeSigningId': 'Apple Development',
        'appium:updatedWDABundleId': config.WDA_BUNDLE_ID,
        'appium:allowProvisioningDeviceRegistration': true,
        'appium:derivedDataPath': path.join(projectDir, 'DerivedData'),
        'appium:noReset': true,
        'appium:shouldTerminateApp': false,
        'appium:useNewWDA': false,
        'appium:showXcodeLog': true,
        'appium:wdaStartupRetries': 1,
        'appium:wdaLaunchTimeout': 120_000,
        'appium:wdaConnectionTimeout': 30_000,
        'appium:newCommandTimeout': 120,
      },
    });
    result.sessionId = driver.sessionId;
    await driver.saveScreenshot(path.join(artifactDir, 'screen.png'));
    result.artifacts.screenshot = 'screen.png';
    await writeFile(path.join(artifactDir, 'source.xml'), await driver.getPageSource(), 'utf8');
    result.artifacts.source = 'source.xml';
    result.status = 'passed';
  } catch (error) {
    failure = error;
    result.status = 'failed';
    result.error = error.message;
  } finally {
    if (driver) {
      try {
        await driver.deleteSession();
        result.sessionClosed = true;
      } catch (error) {
        result.sessionClosed = false;
        result.cleanupError = error.message;
        result.status = 'failed';
        failure ??= error;
      }
    }
    result.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`결과 저장: ${artifactDir}`);
  }

  if (failure) throw failure;
  console.log('연결 확인 완료: 스크린샷과 화면 구조를 저장하고 세션을 종료했습니다.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check') || args.length > 1) {
    throw new Error('사용법: node scripts/smoke.mjs [--check]');
  }
  const config = readConfig();
  if (args.includes('--check')) {
    console.log('환경 변수 형식 검사 통과. 서버·기기·서명 유효성은 확인하지 않았습니다.');
    return;
  }
  await smoke(config);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
