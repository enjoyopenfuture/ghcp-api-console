import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { RuntimeAuthConfig } from '../config.js';
import type { AccountLogger } from '../tasks/accountLogger.js';
import type { AccountCredentials, AuthStrategy } from './types.js';
import type { DeviceCodeResponse } from './deviceFlow.js';

type LogFields = Record<string, unknown>;

interface FailureDiagnostics {
  fields: LogFields;
  traceStopped: boolean;
}

interface LocatorCandidate {
  description: string;
  create(page: Page): Locator;
}

interface LocatedElement {
  description: string;
  locator: Locator;
}

let stealthRegistered = false;

export class HeadlessPlaywrightAuthStrategy implements AuthStrategy {
  readonly name = 'headless-playwright';

  constructor(
    private readonly options: RuntimeAuthConfig,
    private readonly account: AccountCredentials,
    private readonly logger: AccountLogger,
  ) {}

  async authorize(device: DeviceCodeResponse): Promise<void> {
    let stage = 'launch-browser';
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let traceStarted = false;

    try {
      registerStealth(this.logger);
      this.logger.info(stage, 'Starting headless browser authorization', {
        strategy: this.name,
        headless: this.options.headless,
        githubUsername: this.account.githubUsername,
        ssoUsername: this.account.ssoUsername,
        ssoProvider: this.options.ssoProvider,
        ssoUrl: this.options.ssoUrl ? safeUrl(this.options.ssoUrl) : undefined,
      });

      browser = await chromium.launch({
        headless: this.options.headless,
        args: ['--disable-blink-features=AutomationControlled'],
      });
      context = await browser.newContext({
        locale: 'en-US',
        viewport: { width: 1365, height: 768 },
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      if (this.options.debugArtifacts) {
        await mkdir(this.artifactDir(), { recursive: true });
        await context.tracing.start({ screenshots: true, snapshots: true });
        traceStarted = true;
        this.logger.info('debug-artifacts', 'Tracing enabled for failed authorization diagnostics', {
          dir: this.artifactDir(),
        });
      }

      page = await context.newPage();
      page.setDefaultTimeout(this.options.timeoutMs);
      page.setDefaultNavigationTimeout(this.options.timeoutMs);
      this.logNavigations(page);

      stage = 'open-device-page';
      await this.openDevicePage(page, device);

      stage = 'pre-device-login';
      await this.completeLoginIfNeeded(page);

      stage = 'device-code';
      await this.submitDeviceCode(page, device);

      stage = 'post-device-login';
      await this.completeLoginIfNeeded(page);

      stage = 'github-authorize';
      await this.confirmGitHubAuthorization(page);

      this.logger.info('complete', 'Browser authorization flow completed; waiting for GitHub token polling', {
        url: safeUrl(page.url()),
      });
    } catch (err) {
      const diagnostics = await this.captureFailure(stage, page, context, traceStarted);
      if (diagnostics.traceStopped) traceStarted = false;
      this.logger.error(stage, 'Automatic authorization failed', {
        url: page ? safeUrl(page.url()) : undefined,
        error: errorMessage(err),
        ...diagnostics.fields,
      });
      throw new Error(`Automatic device-flow authorization failed during ${stage}: ${errorMessage(err)}`);
    } finally {
      if (context && traceStarted) {
        await context.tracing.stop().catch((err: unknown) => {
          this.logger.warn('debug-artifacts', 'Failed to stop tracing cleanly', { error: errorMessage(err) });
        });
      }
      if (browser) await browser.close();
    }
  }

  private async openDevicePage(page: Page, device: DeviceCodeResponse): Promise<void> {
    this.logger.info('device-code', 'Opening GitHub device verification page', {
      url: safeUrl(device.verification_uri),
      expiresInSeconds: device.expires_in,
    });
    await page.goto(device.verification_uri, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
    await waitForPageSettle(page);
    this.logger.info('device-code', 'Opened GitHub device verification flow', { url: safeUrl(page.url()) });
  }

  private async completeLoginIfNeeded(page: Page): Promise<void> {
    await this.selectGitHubDeviceAccountIfPresent(page);
    if (await this.hasDeviceCodeInput(page)) {
      this.logger.info('login-check', 'Device code form is ready; login is not required before code entry', {
        url: safeUrl(page.url()),
      });
      return;
    }

    const submittedGithubLogin = await this.completeGitHubLogin(page);
    if (submittedGithubLogin || this.isSsoUrl(page.url()) || isGitHubSsoInterstitial(page.url()) || this.hasKnownProviderUrl(page.url())) {
      await this.completeSsoLogin(page);
      await this.selectGitHubDeviceAccountIfPresent(page);
    }

    if (!isGitHubUrl(page.url()) && !this.isSsoUrl(page.url())) {
      throw new Error(`Unexpected external login URL: ${safeUrl(page.url())}`);
    }
  }

  private async submitDeviceCode(page: Page, device: DeviceCodeResponse): Promise<void> {
    await this.selectGitHubDeviceAccountIfPresent(page);
    if (!(await this.hasDeviceCodeInput(page))) {
      this.logger.info('device-code', 'Waiting for GitHub device code form after login', { url: safeUrl(page.url()) });
      const reachedGitHub = await this.waitForUrl(page, 'device-code', (url) => isGitHubUrl(url), this.options.timeoutMs);
      if (!reachedGitHub) {
        throw new Error(`Device code form did not become available; current URL: ${safeUrl(page.url())}`);
      }
    }
    await this.fillDeviceCode(page, device.user_code);
    await this.clickFirst(page, 'device-code', this.deviceCodeSubmitCandidates(), 'device code submit');
    await waitForPageSettle(page);
    this.logger.info('device-code', 'Submitted GitHub device code', { url: safeUrl(page.url()) });
  }

  private async completeGitHubLogin(page: Page): Promise<boolean> {
    if (this.isSsoUrl(page.url()) || this.hasKnownProviderUrl(page.url())) {
      this.logger.info('github-login', 'Already redirected to SSO login', { url: safeUrl(page.url()) });
      return false;
    }
    if (!isGitHubUrl(page.url())) {
      throw new Error(`Expected GitHub login or device page, got ${safeUrl(page.url())}`);
    }

    this.logger.info('github-login', 'Checking whether GitHub username entry is required', {
      url: safeUrl(page.url()),
      githubUsername: this.account.githubUsername,
    });
    const input = await this.firstVisible(page, 'github-login', this.githubLoginInputCandidates(), 4_000);
    if (!input) {
      this.logger.info('github-login', 'GitHub username form not shown; continuing', { url: safeUrl(page.url()) });
      return false;
    }

    await input.locator.fill(this.account.githubUsername);
    this.logger.info('github-login', 'Filled GitHub username', {
      candidate: input.description,
      githubUsername: this.account.githubUsername,
    });
    await this.clickFirst(page, 'github-login', this.githubLoginSubmitCandidates(), 'GitHub login submit');
    await waitForPageSettle(page);
    this.logger.info('github-login', 'Submitted GitHub login step', { url: safeUrl(page.url()) });
    return true;
  }

  private async completeSsoLogin(page: Page): Promise<void> {
    for (let attempt = 1; attempt <= 2 && !this.isSsoUrl(page.url()) && !this.hasKnownProviderUrl(page.url()); attempt++) {
      if (await this.hasDeviceCodeInput(page)) {
        this.logger.info('sso-login', 'SSO page was not required; device code form is available', { url: safeUrl(page.url()) });
        return;
      }

      await this.continueGitHubSsoIfPresent(page);
      if (this.isSsoUrl(page.url())) break;
      if (await this.hasDeviceCodeInput(page)) {
        this.logger.info('sso-login', 'SSO page was not required after GitHub SSO check', { url: safeUrl(page.url()) });
        return;
      }

      this.logger.info('sso-login', 'Waiting for SSO redirect', {
        expectedUrl: this.options.ssoUrl ? safeUrl(this.options.ssoUrl) : undefined,
        currentUrl: safeUrl(page.url()),
        provider: this.options.ssoProvider,
        attempt,
      });
      const reachedSsoOrInterstitial = await this.waitForUrl(
        page,
        'sso-login',
        (url) => this.isSsoUrl(url) || isGitHubSsoInterstitial(url) || this.hasKnownProviderUrl(url),
        30_000,
      );
      if (!reachedSsoOrInterstitial) {
        this.logger.info('sso-login', 'SSO page was not reached; continuing on current page', {
          url: safeUrl(page.url()),
        });
        return;
      }
    }

    if (!this.isSsoUrl(page.url()) && !this.hasKnownProviderUrl(page.url())) {
      this.logger.info('sso-login', 'SSO page was not reached after GitHub interstitial handling', {
        url: safeUrl(page.url()),
      });
      return;
    }

    await waitForPageSettle(page);
    this.logger.info('sso-login', 'Submitting SSO credentials', {
      url: safeUrl(page.url()),
      provider: this.options.ssoProvider,
      ssoUsername: this.account.ssoUsername,
    });
    switch (this.options.ssoProvider) {
      case 'custom':
        await this.completeCustomSsoLogin(page);
        break;
      case 'azure':
        await this.completeAzureSsoLogin(page);
        break;
    }

    const returnedToGitHub = await this.waitForUrl(page, 'sso-login', (url) => isGitHubUrl(url), this.options.timeoutMs);
    if (!returnedToGitHub) {
      throw new Error(`SSO login did not return to GitHub before timeout; current URL: ${safeUrl(page.url())}`);
    }
    this.logger.info('sso-login', 'Returned to GitHub after SSO login', { url: safeUrl(page.url()) });
  }

  private async completeCustomSsoLogin(page: Page): Promise<void> {
    await this.fillFirst(page, 'sso-login', this.ssoUsernameInputCandidates(), this.account.ssoUsername, 'SSO username');
    await this.fillFirst(page, 'sso-login', this.ssoPasswordInputCandidates(), this.account.ssoPassword, 'SSO password');
    await this.clickFirst(page, 'sso-login', this.ssoSubmitCandidates(), 'SSO submit');
    await waitForPageSettle(page);
  }

  private async completeAzureSsoLogin(page: Page): Promise<void> {
    await this.fillFirst(page, 'sso-login', this.azureUsernameInputCandidates(), this.account.ssoUsername, 'Azure username');
    await this.clickFirst(page, 'sso-login', this.azureNextSubmitCandidates(), 'Azure next');
    await waitForPageSettle(page);

    await this.fillFirst(page, 'sso-login', this.azurePasswordInputCandidates(), this.account.ssoPassword, 'Azure password');
    await this.clickFirst(page, 'sso-login', this.azureSignInSubmitCandidates(), 'Azure sign in');
    await waitForPageSettle(page);

    await this.handleAzureStaySignedInIfPresent(page);
  }

  private async handleAzureStaySignedInIfPresent(page: Page): Promise<void> {
    const candidates = this.options.azureStaySignedIn
      ? this.azureStaySignedInYesCandidates()
      : this.azureStaySignedInNoCandidates();
    const control = await this.firstVisible(page, 'sso-login', candidates, 1_000);
    if (!control) {
      this.logger.debug('sso-login', 'Azure stay signed in prompt not shown', { url: safeUrl(page.url()) });
      return;
    }

    await control.locator.click();
    await waitForPageSettle(page);
    this.logger.info('sso-login', 'Handled Azure stay signed in prompt', {
      candidate: control.description,
      staySignedIn: this.options.azureStaySignedIn,
    });
  }

  private async selectGitHubDeviceAccountIfPresent(page: Page): Promise<void> {
    if (!isGitHubDeviceAccountSelectionUrl(page.url())) return;

    this.logger.info('github-account', 'Selecting GitHub account for device flow', {
      url: safeUrl(page.url()),
      githubUsername: this.account.githubUsername,
    });
    const account = await this.firstVisible(page, 'github-account', this.githubAccountSelectionCandidates(), 5_000);
    if (!account) {
      throw new Error(`Could not find GitHub account selection control on ${safeUrl(page.url())}`);
    }
    await account.locator.click();
    await waitForPageSettle(page);
    this.logger.info('github-account', 'Selected GitHub account for device flow', {
      candidate: account.description,
      url: safeUrl(page.url()),
    });
  }

  private async continueGitHubSsoIfPresent(page: Page): Promise<void> {
    if (!isGitHubSsoInterstitial(page.url())) return;

    this.logger.info('github-sso', 'Continuing from GitHub enterprise SSO page', { url: safeUrl(page.url()) });
    const control = await this.firstVisible(page, 'github-sso', this.githubSsoSubmitCandidates(), 5_000);
    if (!control) {
      throw new Error(`Could not find GitHub SSO continue control on ${safeUrl(page.url())}`);
    }
    await control.locator.click();
    await waitForPageSettle(page);
    this.logger.info('github-sso', 'Clicked GitHub enterprise SSO continue control', {
      candidate: control.description,
      url: safeUrl(page.url()),
    });
  }

  private async confirmGitHubAuthorization(page: Page): Promise<void> {
    if (!isGitHubUrl(page.url())) {
      this.logger.info('github-authorize', 'Waiting for GitHub authorization page', { url: safeUrl(page.url()) });
      const returnedToGitHub = await this.waitForUrl(
        page,
        'github-authorize',
        (url) => isGitHubUrl(url),
        this.options.timeoutMs,
      );
      if (!returnedToGitHub) {
        throw new Error(`Browser did not reach GitHub authorization page; current URL: ${safeUrl(page.url())}`);
      }
    }

    await waitForPageSettle(page);
    const button = await this.firstVisible(page, 'github-authorize', this.githubAuthorizeCandidates(), 5_000);
    if (!button) {
      this.logger.info('github-authorize', 'No explicit authorization button found; token polling will verify status', {
        url: safeUrl(page.url()),
      });
      return;
    }

    await button.locator.click();
    await waitForPageSettle(page);
    this.logger.info('github-authorize', 'Clicked GitHub authorization confirmation', {
      candidate: button.description,
      url: safeUrl(page.url()),
    });
  }

  private async fillFirst(
    page: Page,
    step: string,
    candidates: LocatorCandidate[],
    value: string,
    label: string,
  ): Promise<void> {
    const element = await this.firstVisible(page, step, candidates, 2_000);
    if (!element) throw new Error(`Could not find ${label} input on ${safeUrl(page.url())}`);
    await element.locator.fill(value);
    this.logger.debug(step, `Filled ${label}`, { candidate: element.description });
  }

  private async clickFirst(
    page: Page,
    step: string,
    candidates: LocatorCandidate[],
    label: string,
  ): Promise<void> {
    const element = await this.firstVisible(page, step, candidates, 2_000);
    if (!element) throw new Error(`Could not find ${label} control on ${safeUrl(page.url())}`);
    await element.locator.click();
    this.logger.debug(step, `Clicked ${label}`, { candidate: element.description });
  }

  private async firstVisible(
    page: Page,
    step: string,
    candidates: LocatorCandidate[],
    timeoutMs: number,
  ): Promise<LocatedElement | undefined> {
    for (const candidate of candidates) {
      const locator = candidate.create(page);
      try {
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
        this.logger.debug(step, 'Located visible element', { candidate: candidate.description });
        return { description: candidate.description, locator };
      } catch {
        this.logger.debug(step, 'Element candidate not visible', { candidate: candidate.description });
      }
    }
    return undefined;
  }

  private async waitForUrl(
    page: Page,
    step: string,
    predicate: (url: string) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    if (predicate(page.url())) return true;
    try {
      await page.waitForURL((url) => predicate(String(url)), { timeout: timeoutMs });
      return true;
    } catch {
      this.logger.debug(step, 'Timed out waiting for URL transition', { url: safeUrl(page.url()) });
      return predicate(page.url());
    }
  }

  private async hasDeviceCodeInput(page: Page): Promise<boolean> {
    return (
      (await this.firstVisible(page, 'device-code', this.deviceCodeInputCandidates(), 500)) !== undefined ||
      (await this.segmentedDeviceCodeInputs(page)).length > 0
    );
  }

  private async fillDeviceCode(page: Page, userCode: string): Promise<void> {
    const singleInput = await this.firstVisible(page, 'device-code', this.deviceCodeInputCandidates(), 1_000);
    if (singleInput) {
      await singleInput.locator.fill(userCode);
      this.logger.debug('device-code', 'Filled single device code input', { candidate: singleInput.description });
      return;
    }

    const inputs = await this.segmentedDeviceCodeInputs(page);
    const code = userCode.replace(/[^a-z0-9]/gi, '');
    if (inputs.length < code.length) {
      throw new Error(`Could not find enough segmented device code inputs on ${safeUrl(page.url())}`);
    }

    for (let i = 0; i < code.length; i++) {
      await inputs[i].fill(code[i]);
    }
    this.logger.debug('device-code', 'Filled segmented device code inputs', { inputCount: inputs.length });
  }

  private async segmentedDeviceCodeInputs(page: Page): Promise<Locator[]> {
    const locator = page.locator('input[type="text"], input[inputmode="numeric"], input:not([type])');
    const count = await locator.count();
    const visible: Locator[] = [];
    for (let i = 0; i < count; i++) {
      const input = locator.nth(i);
      if (await input.isVisible()) visible.push(input);
    }
    return visible.length >= 6 ? visible : [];
  }

  private deviceCodeInputCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured device code input', this.options.selectors.deviceCodeInput),
      cssCandidate('input[name="user_code"]', 'input[name="user_code"]'),
      cssCandidate('input[name="code"]', 'input[name="code"]'),
    ];
  }

  private githubAccountSelectionCandidates(): LocatorCandidate[] {
    const username = escapedRegExp(this.account.githubUsername);
    return [
      roleButtonCandidate('account button matching GitHub username', username),
      roleLinkCandidate('account link matching GitHub username', username),
      textCandidate('account text matching GitHub username', this.account.githubUsername),
      roleButtonCandidate('continue button', /continue|select|use this account/i),
      roleLinkCandidate('continue link', /continue|select|use this account/i),
      cssCandidate('submit button', 'button[type="submit"]'),
      cssCandidate('submit input', 'input[type="submit"]'),
      cssCandidate('device flow link', 'a[href*="/login/device"]'),
    ];
  }

  private githubSsoSubmitCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured GitHub SSO submit', this.options.selectors.githubSsoSubmit),
      roleButtonCandidate('continue button', /continue/i),
      roleButtonCandidate('sign in with SSO button', /single sign-on|sso|identity provider|sign in/i),
      roleLinkCandidate('continue link', /continue/i),
      roleLinkCandidate('identity provider link', /single sign-on|sso|identity provider|sign in/i),
      cssCandidate('submit button', 'button[type="submit"]'),
      cssCandidate('submit input', 'input[type="submit"]'),
      cssCandidate('SSO link', 'a[href*="sso"]'),
    ];
  }

  private deviceCodeSubmitCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured device code submit', this.options.selectors.deviceCodeSubmit),
      roleButtonCandidate('continue button', /continue/i),
      cssCandidate('submit button', 'button[type="submit"]'),
      cssCandidate('submit input', 'input[type="submit"]'),
    ];
  }

  private githubLoginInputCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured GitHub login input', this.options.selectors.githubLoginInput),
      cssCandidate('GitHub login field', '#login_field'),
      cssCandidate('login input', 'input[name="login"]'),
      cssCandidate('username input', 'input[name="username"]'),
      cssCandidate('email input', 'input[type="email"]'),
      cssCandidate('text input', 'input[type="text"]'),
    ];
  }

  private githubLoginSubmitCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured GitHub login submit', this.options.selectors.githubLoginSubmit),
      roleButtonCandidate('continue button', /continue/i),
      roleButtonCandidate('sign in button', /sign in|log in|login/i),
      cssCandidate('GitHub commit input', 'input[name="commit"]'),
      cssCandidate('GitHub primary submit input', 'input.btn-primary[type="submit"]'),
      cssCandidate('GitHub primary submit button', 'button.btn-primary[type="submit"]'),
    ];
  }

  private ssoUsernameInputCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured SSO username input', this.options.selectors.ssoUsernameInput),
      cssCandidate('username input', 'input[name="username"]'),
      cssCandidate('login input', 'input[name="login"]'),
      cssCandidate('user input', 'input[name="user"]'),
      cssCandidate('email input', 'input[type="email"]'),
      cssCandidate('text input', 'input[type="text"]'),
    ];
  }

  private ssoPasswordInputCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured SSO password input', this.options.selectors.ssoPasswordInput),
      cssCandidate('password input', 'input[type="password"]'),
      cssCandidate('password field', 'input[name="password"]'),
    ];
  }

  private ssoSubmitCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured SSO submit', this.options.selectors.ssoSubmit),
      roleButtonCandidate('sign in button', /sign in|log in|login|submit|continue/i),
      cssCandidate('submit button', 'button[type="submit"]'),
      cssCandidate('submit input', 'input[type="submit"]'),
    ];
  }

  private azureUsernameInputCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured Azure username input', this.options.selectors.azureUsernameInput),
      cssCandidate('Azure loginfmt input', 'input[name="loginfmt"]'),
      cssCandidate('Azure username input', '#i0116'),
      cssCandidate('email input', 'input[type="email"]'),
      cssCandidate('text input', 'input[type="text"]'),
    ];
  }

  private azureNextSubmitCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured Azure next submit', this.options.selectors.azureNextSubmit),
      roleButtonCandidate('next button', /next/i),
      cssCandidate('Azure primary submit', '#idSIButton9'),
      cssCandidate('submit button', 'button[type="submit"]'),
      cssCandidate('submit input', 'input[type="submit"]'),
    ];
  }

  private azurePasswordInputCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured Azure password input', this.options.selectors.azurePasswordInput),
      cssCandidate('Azure password input', '#i0118'),
      cssCandidate('password input', 'input[type="password"]'),
      cssCandidate('password field', 'input[name="passwd"]'),
      cssCandidate('password field', 'input[name="password"]'),
    ];
  }

  private azureSignInSubmitCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured Azure sign in submit', this.options.selectors.azureSignInSubmit),
      roleButtonCandidate('sign in button', /sign in/i),
      cssCandidate('Azure primary submit', '#idSIButton9'),
      cssCandidate('submit button', 'button[type="submit"]'),
      cssCandidate('submit input', 'input[type="submit"]'),
    ];
  }

  private azureStaySignedInYesCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured Azure stay signed in yes', this.options.selectors.azureStaySignedInYes),
      roleButtonCandidate('yes button', /^yes$/i),
      cssCandidate('Azure primary yes', '#idSIButton9'),
    ];
  }

  private azureStaySignedInNoCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured Azure stay signed in no', this.options.selectors.azureStaySignedInNo),
      roleButtonCandidate('no button', /^no$/i),
      cssCandidate('Azure back no', '#idBtn_Back'),
    ];
  }

  private githubAuthorizeCandidates(): LocatorCandidate[] {
    return [
      ...selectorCandidates('configured GitHub authorize submit', this.options.selectors.githubAuthorizeSubmit),
      roleButtonCandidate('authorize button', /authorize|allow|confirm/i),
      roleButtonCandidate('continue button', /continue/i),
      cssCandidate('submit button', 'button[type="submit"]'),
      cssCandidate('submit input', 'input[type="submit"]'),
    ];
  }

  private isSsoUrl(rawUrl: string): boolean {
    if (!this.options.ssoUrl) return false;
    try {
      const current = new URL(rawUrl);
      const expected = new URL(this.options.ssoUrl);
      return current.origin === expected.origin && current.pathname.startsWith(expected.pathname);
    } catch {
      return false;
    }
  }

  private hasKnownProviderUrl(rawUrl: string): boolean {
    if (this.options.ssoProvider !== 'azure') return false;
    try {
      const hostname = new URL(rawUrl).hostname.toLowerCase();
      return hostname === 'login.microsoftonline.com' || hostname.endsWith('.login.microsoftonline.com') || hostname === 'login.live.com';
    } catch {
      return false;
    }
  }

  private logNavigations(page: Page): void {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.logger.debug('navigation', 'Main frame navigated', { url: safeUrl(frame.url()) });
      }
    });
  }

  private async captureFailure(
    stage: string,
    page: Page | undefined,
    context: BrowserContext | undefined,
    traceStarted: boolean,
  ): Promise<FailureDiagnostics> {
    const fields: LogFields = {};
    let traceStopped = false;
    if (!this.options.debugArtifacts) return { fields, traceStopped };

    const dir = this.artifactDir();
    await mkdir(dir, { recursive: true });
    const prefix = `${Date.now()}-${stage.replace(/[^a-z0-9-]/gi, '-')}`;

    if (page) {
      const screenshotPath = resolve(dir, `${prefix}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        fields.screenshotPath = screenshotPath;
      } catch (err) {
        fields.screenshotError = errorMessage(err);
      }
    }

    if (context && traceStarted) {
      const tracePath = resolve(dir, `${prefix}.zip`);
      try {
        await context.tracing.stop({ path: tracePath });
        fields.tracePath = tracePath;
        traceStopped = true;
      } catch (err) {
        fields.traceError = errorMessage(err);
      }
    }

    return { fields, traceStopped };
  }

  private artifactDir(): string {
    return resolve(process.cwd(), this.options.debugArtifactsDir, sanitizeFileName(this.account.ssoUsername || this.account.githubUsername));
  }
}

function registerStealth(logger: AccountLogger): void {
  if (stealthRegistered) return;
  chromium.use(stealthPlugin());
  stealthRegistered = true;
  logger.debug('launch-browser', 'Registered playwright stealth plugin');
}

function selectorCandidates(description: string, selector: string | undefined): LocatorCandidate[] {
  return selector ? [cssCandidate(description, selector)] : [];
}

function cssCandidate(description: string, selector: string): LocatorCandidate {
  return { description, create: (page) => page.locator(selector).first() };
}

function roleButtonCandidate(description: string, name: RegExp): LocatorCandidate {
  return { description, create: (page) => page.getByRole('button', { name }).first() };
}

function roleLinkCandidate(description: string, name: RegExp): LocatorCandidate {
  return { description, create: (page) => page.getByRole('link', { name }).first() };
}

function textCandidate(description: string, text: string): LocatorCandidate {
  return { description, create: (page) => page.getByText(text, { exact: false }).first() };
}

function escapedRegExp(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

async function waitForPageSettle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
}

function isGitHubDeviceAccountSelectionUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return isGitHubUrl(rawUrl) && url.pathname.toLowerCase().includes('/login/device/select_account');
  } catch {
    return false;
  }
}

function isGitHubSsoInterstitial(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return isGitHubUrl(rawUrl) && url.pathname.toLowerCase().includes('/sso');
  } catch {
    return false;
  }
}

function isGitHubUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === 'github.com' || hostname.endsWith('.github.com');
  } catch {
    return false;
  }
}

function safeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.search) url.search = '?redacted';
    if (url.hash) url.hash = '#redacted';
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sanitizeFileName(name: string): string {
  const sanitized = name.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'account';
}
