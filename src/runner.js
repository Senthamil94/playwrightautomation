const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadCredentials } = require('./credentials');

function wpAdminUrl(fromUrl) {
  const parsed = new URL(fromUrl);
  return `${parsed.origin}/wp-admin/`;
}

/** Public homepage from an Admin URL: https://duchesspleasanton.com/mary/ → https://duchesspleasanton.com */
function publicSiteUrl(fromUrl) {
  try {
    return new URL(fromUrl).origin;
  } catch {
    const trimmed = String(fromUrl || '').trim();
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      return new URL(withProtocol).origin;
    } catch {
      return trimmed.replace(/\/+$/, '');
    }
  }
}

const FLYER_POPUP_SELECTOR =
  '#sgpb-popup-dialog-main-div-wrapper, [id^="sgpb-popup-dialog-main-div-wrapper"]';

async function visibleSoon(locator, timeout = 400) {
  return locator.isVisible({ timeout }).catch(() => false);
}

const NAV_TIMEOUT = 60000;
const TEST_NAV_TIMEOUT = 20000;
const TEST_POPUP_WAIT = 8000;

function siteBudgetMs(mode) {
  if (mode === 'test') return 40000;
  if (mode === 'disable') return 90000;
  return 180000;
}

async function gotoPage(page, url, timeout = NAV_TIMEOUT) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/Timeout|net::ERR_|NS_ERROR_/i.test(msg)) throw error;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  }
}

async function dismissAdminEmailScreen(page, adminUrl) {
  const adminMenu = page.locator('#adminmenu');
  const remindMeLater = page.getByRole('link', { name: /Remind me later/i });
  const emailHeading = page.getByRole('heading', { name: /Administration email verification/i });
  const emailCorrect = page.getByRole('button', { name: /The email is correct/i });

  await Promise.race([
    adminMenu.waitFor({ state: 'visible', timeout: 30000 }),
    remindMeLater.waitFor({ state: 'visible', timeout: 30000 }),
    emailHeading.waitFor({ state: 'visible', timeout: 30000 }),
  ]).catch(() => {});

  if (await visibleSoon(adminMenu, 200)) return;

  if (await visibleSoon(remindMeLater, 400)) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      remindMeLater.click(),
    ]);
  } else if (await visibleSoon(emailCorrect, 400)) {
    await emailCorrect.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  if (!(await visibleSoon(adminMenu, 5000))) {
    await gotoPage(page, adminUrl).catch(() => {});
  }

  if (await visibleSoon(remindMeLater, 800)) {
    await remindMeLater.click();
    await gotoPage(page, adminUrl).catch(() => {});
  }

  await adminMenu.waitFor({ state: 'visible', timeout: 30000 });
}

async function takeScreenshot(page, filePath) {
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, 'fonts', {
        value: { ready: Promise.resolve(), status: 'loaded', check: () => true },
        configurable: true,
      });
    });
  } catch {
    // ignore
  }

  try {
    await page.screenshot({
      path: filePath,
      animations: 'disabled',
      timeout: 5000,
    });
  } catch {
    // ignore screenshot failures
  }
}

async function loginToAdmin(page, site) {
  const adminUrl = wpAdminUrl(site.url);

  await gotoPage(page, site.url);
  await page.locator('#user_login').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#user_login').fill(site.username);
  await page.locator('#user_pass').fill(site.password);
  await page.locator('#wp-submit').click();
  await dismissAdminEmailScreen(page, adminUrl);

  return adminUrl;
}

async function loginAndOpenPopupBuilder(page, site) {
  const adminUrl = await loginToAdmin(page, site);
  const listUrl = new URL('/wp-admin/edit.php?post_type=popupbuilder', adminUrl).toString();
  await gotoPage(page, listUrl);
  return adminUrl;
}

async function selectUploadedImage(page, flyerBaseName) {
  const chooseImageButton = page.locator(
    'button.media-button-select.button-primary',
    { hasText: 'Choose Image' }
  );
  const alreadySelected = page.locator('.media-modal li.attachment[aria-checked="true"]');

  if (await visibleSoon(alreadySelected, 2500) && (await chooseImageButton.isEnabled().catch(() => false))) {
    return chooseImageButton;
  }

  await page.locator('#menu-item-browse').click({ force: true });

  const firstImage = page
    .locator(`.media-modal li.attachment[aria-label="${flyerBaseName}"]`)
    .or(page.locator('.media-modal li.attachment').first())
    .first();
  await firstImage.waitFor({ state: 'visible', timeout: 20000 });

  const selectTarget = firstImage
    .locator('.js--select-attachment, .attachment-preview, .thumbnail')
    .first();
  if (await selectTarget.count()) {
    await selectTarget.click({ force: true });
  } else {
    await firstImage.click({ force: true });
  }

  if ((await firstImage.getAttribute('aria-checked')) !== 'true') {
    await firstImage.click({ force: true });
  }

  await chooseImageButton.waitFor({ state: 'visible', timeout: 10000 });
  return chooseImageButton;
}

async function createPopupForSite(page, site, flyerPath, popupTitle) {
  const adminUrl = await loginToAdmin(page, site);
  const flyerBaseName = path.parse(flyerPath).name;

  const imageCreateUrl = new URL(
    '/wp-admin/post-new.php?post_type=popupbuilder&sgpb_type=image',
    adminUrl
  ).toString();

  await gotoPage(page, imageCreateUrl);

  const titleInput = page.locator('#titlewrap #title');
  const imageBox = page
    .locator('div.sgpb-box.sgpb-box-active.sgpb-margin-bottom-30.sgpb-position-relative')
    .first();

  const landed = await Promise.race([
    titleInput.waitFor({ state: 'visible', timeout: 25000 }).then(() => 'editor'),
    imageBox.waitFor({ state: 'visible', timeout: 25000 }).then(() => 'picker'),
  ]).catch(() => null);

  if (landed === 'picker') {
    const redirectUrl = await imageBox.getAttribute('data-redirect-url');
    if (redirectUrl) {
      await gotoPage(page, redirectUrl);
    } else {
      await imageBox.click({ force: true });
    }
    await titleInput.waitFor({ state: 'visible', timeout: 25000 });
  } else if (landed !== 'editor') {
    await gotoPage(page, imageCreateUrl);
    await titleInput.waitFor({ state: 'visible', timeout: 25000 });
  }

  await titleInput.fill(popupTitle);

  const uploadImageButton = page.locator('#js-upload-image-button');
  await uploadImageButton.waitFor({ state: 'visible', timeout: 15000 });
  await uploadImageButton.click({ force: true });

  const mediaModal = page.locator('.media-modal');
  await mediaModal.waitFor({ state: 'visible', timeout: 15000 });

  await page.locator('#menu-item-upload').waitFor({ state: 'attached', timeout: 10000 });
  await page.locator('#menu-item-upload').click({ force: true });
  const fileInput = page.locator('.media-modal input[type="file"]').last();
  await fileInput.setInputFiles(flyerPath);

  await page
    .locator('.media-uploader-status.uploading')
    .waitFor({ state: 'hidden', timeout: 60000 })
    .catch(() => {});

  const chooseImageButton = await selectUploadedImage(page, flyerBaseName);
  await Promise.all([
    mediaModal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {}),
    chooseImageButton.click({ force: true }),
  ]);

  const publishButton = page.locator('#publish');
  await publishButton.waitFor({ state: 'visible', timeout: 15000 });
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    publishButton.click({ force: true }),
  ]);
  await page
    .locator('#message.updated, .notice-success, #sample-permalink')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});
}

/** Decode HTML entities in Popup Builder onclick trash URLs (&amp; → &). */
function decodeTrashUrl(raw) {
  return String(raw || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

/**
 * Extract trash URL from Popup Builder Remove icon:
 * <img class="icon_remove" title="Remove"
 *   onclick="location.href='.../post.php?post=398&amp;action=trash&amp;_wpnonce=...'">
 */
function trashUrlFromOnclick(onclick) {
  const match = String(onclick || '').match(
    /location\.href\s*=\s*['"]([^'"]+)['"]/i
  );
  if (!match) return null;
  const url = decodeTrashUrl(match[1]);
  if (!/action=trash/i.test(url)) return null;
  return url;
}

/** Turn Playwright/raw errors into short reasons for the UI. */
function humanizeJobError(error, mode) {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split('\n')[0].trim();

  if (
    /could not delete flyer|trash action|remove icon|popup list|login|popup builder|could not reach/i.test(
      first
    )
  ) {
    return first.slice(0, 280);
  }
  if (/user_login|locator\.fill/i.test(first)) {
    return 'Could not open WordPress login (username field missing — wrong URL, site down, or already logged out).';
  }
  if (/user_pass/i.test(first)) {
    return 'Could not fill password on the login form.';
  }
  if (/wp-submit|Log In/i.test(first)) {
    return 'Could not click the Log In button.';
  }
  if (/adminmenu|Administration email/i.test(first)) {
    return 'Logged in, but WordPress admin dashboard did not load.';
  }
  if (/Popup Builder|wp-menu-name/i.test(first)) {
    return 'Popup Builder menu not found — plugin may be missing or user lacks access.';
  }
  if (/icon_remove|Remove|recycle-bin/i.test(first)) {
    return 'Remove (trash) icon not found on the first popup row.';
  }
  if (/Flyer not found/i.test(first)) {
    return first.slice(0, 280);
  }
  if (/Timeout/i.test(first)) {
    if (mode === 'test') return `Timed out while checking flyer: ${first.slice(0, 160)}`;
    return mode === 'disable'
      ? `Timed out while deleting flyer: ${first.slice(0, 160)}`
      : `Timed out while uploading flyer: ${first.slice(0, 160)}`;
  }
  if (/net::ERR_|NS_ERROR_|Navigation failed/i.test(first)) {
    return `Site unreachable: ${first.slice(0, 180)}`;
  }
  return first.slice(0, 280);
}

function isTimeoutError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return /Timeout|timed?\s*out/i.test(msg);
}

/**
 * Delete (move to Trash) the first popup row (flyer is usually row 1)
 * by using the pink Remove / recycle-bin icon in the popup list.
 */
async function deletePopupForSite(page, site) {
  let adminUrl;
  try {
    adminUrl = await loginAndOpenPopupBuilder(page, site);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Popup Builder: ${msg.split('\n')[0].slice(0, 160)}`);
  }

  const listUrl = new URL('/wp-admin/edit.php?post_type=popupbuilder', adminUrl).toString();
  if (!page.url().includes('edit.php') || !page.url().includes('post_type=popupbuilder')) {
    await gotoPage(page, listUrl);
  }

  try {
    await page
      .locator('table.wp-list-table, .no-items')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    throw new Error('Popup list did not load (All Popups table missing).');
  }

  const noItems = page.locator('.no-items');
  if (await visibleSoon(noItems, 400)) {
    return 0;
  }

  const firstRow = page.locator('table.wp-list-table tbody#the-list > tr[id^="post-"]').first();
  try {
    await firstRow.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    throw new Error('No popup rows found in the list (expected id="post-…").');
  }
  await firstRow.scrollIntoViewIfNeeded().catch(() => {});

  const postId = ((await firstRow.getAttribute('id')) || '').replace(/^post-/, '');

  const removeIcon = firstRow
    .locator(
      [
        'div.icon.icon_pink img.icon_remove',
        'div.icon.icon_pink img[title="Remove"]',
        'img.icon_remove[title="Remove"]',
        'img.icon_remove',
        'img[title="Remove"][src*="recycle-bin"]',
      ].join(', ')
    )
    .first();
  try {
    await removeIcon.waitFor({ state: 'attached', timeout: 15000 });
  } catch {
    throw new Error('Remove (trash) icon not found on the first popup row.');
  }

  const trashUrl =
    trashUrlFromOnclick(await removeIcon.getAttribute('onclick')) ||
    trashUrlFromOnclick(
      await removeIcon.evaluate((el) => el.getAttribute('onclick') || '')
    );

  // Same navigation the icon would do in-page (keeps cookies/referrer).
  if (trashUrl) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.evaluate((url) => {
        window.location.href = url;
      }, trashUrl),
    ]);
  } else {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      removeIcon.click({ force: true }),
    ]);
  }

  await Promise.race([
    page.waitForURL(/[?&]trashed=/, { timeout: 12000 }),
    page
      .locator('#message, .notice, .updated, .notice-success')
      .filter({ hasText: /moved to the Trash|1 post moved|trashed/i })
      .first()
      .waitFor({ state: 'visible', timeout: 12000 }),
  ]).catch(() => {});

  const landedUrl = page.url();
  const noticeVisible = await visibleSoon(
    page
      .locator('#message, .notice, .updated, .notice-success')
      .filter({ hasText: /moved to the Trash|1 post moved|trashed/i })
      .first(),
    800
  );

  const urlConfirms = /[?&]trashed=/.test(landedUrl);

  let rowGone = false;
  if (postId) {
    rowGone = !(await visibleSoon(
      page.locator(`table.wp-list-table tbody#the-list > tr#post-${postId}`),
      600
    ));
  }
  const listEmpty = await visibleSoon(page.locator('.no-items'), 400);

  if (urlConfirms || noticeVisible || rowGone || listEmpty) {
    return 1;
  }

  const title = (await page.title().catch(() => '')) || '';
  const bodyHint = await page
    .locator('body')
    .innerText()
    .then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 120))
    .catch(() => '');

  if (/link has expired|are you sure|nonce|forbidden|not allowed/i.test(`${title} ${bodyHint}`)) {
    throw new Error(
      `Could not delete flyer — WordPress rejected the trash link (expired nonce or permissions). Page: ${title || landedUrl}`
    );
  }

  throw new Error(
    `Could not delete flyer — trash did not confirm after Remove. Landed on: ${landedUrl.slice(0, 160)}`
  );
}

/** Normalized identity for a website (protocol + domain), used to detect duplicates. */
function siteKey(url) {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return String(url).toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Remove rows that point to the same website so no site is uploaded twice.
 */
function dedupeSites(sites) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];

  for (const site of sites) {
    const key = siteKey(site.url);
    if (seen.has(key)) {
      duplicates.push(site);
    } else {
      seen.add(key);
      unique.push(site);
    }
  }

  return { unique, duplicates };
}

async function frameHasFlyer(frame) {
  try {
    return await Promise.race([
      frame.evaluate((sel) => Boolean(document.querySelector(sel)), FLYER_POPUP_SELECTOR),
      new Promise((resolve) => setTimeout(() => resolve(false), 400)),
    ]);
  } catch {
    return false;
  }
}

/**
 * Open the public website (domain only) and check whether the Popup Builder
 * flyer wrapper is in the page. Logged-out visit — admins often do not see popups.
 *
 * Do not use locator.count() across iframes: a stuck/navigating frame can
 * ignore Playwright's timeout and freeze a worker indefinitely.
 */
async function flyerPopupPresent(page, timeout = TEST_POPUP_WAIT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await frameHasFlyer(page.mainFrame())) return true;

    const extras = page.frames().filter((frame) => frame !== page.mainFrame()).slice(0, 6);
    for (const frame of extras) {
      if (Date.now() >= deadline) break;
      if (await frameHasFlyer(frame)) return true;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(300, remaining)));
  }
  return false;
}

async function testFlyerOnSite(page, site) {
  const publicUrl = publicSiteUrl(site.url);
  if (!publicUrl) {
    throw new Error('Could not read domain from Admin URL');
  }

  try {
    await page.goto(publicUrl, { waitUntil: 'domcontentloaded', timeout: TEST_NAV_TIMEOUT });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/net::ERR_|NS_ERROR_|Navigation failed/i.test(msg) && !/Timeout/i.test(msg)) {
      throw new Error(`Site unreachable: ${msg.split('\n')[0].slice(0, 180)}`);
    }
    // Timed-out / partial load: still inspect whatever DOM we have.
  }

  const enabled = await flyerPopupPresent(page, TEST_POPUP_WAIT);
  return { enabled, publicUrl };
}

/**
 * @param {object} options
 * @param {'upload'|'disable'|'test'} [options.mode]
 * @param {string} options.credentialsPath
 * @param {string} [options.flyerPath]
 * @param {string} [options.popupTitle]
 * @param {boolean} [options.headless]
 * @param {number} [options.concurrency] how many sites to process at the same time
 * @param {number} [options.startRow] first sheet row to process — earlier rows are skipped
 * @param {string[]} [options.skipKeys] site keys already uploaded — skipped to avoid duplicates
 * @param {() => boolean} [options.shouldStop]
 * @param {(event: object) => void} [options.onProgress]
 */
async function runPopupJob(options) {
  const {
    mode = 'upload',
    credentialsPath,
    flyerPath,
    popupTitle = 'Weekend Special',
    headless = true,
    concurrency = 8,
    startRow = 1,
    skipKeys = [],
    shouldStop = () => false,
    onProgress = () => {},
  } = options;

  if (mode === 'upload') {
    if (!flyerPath || !fs.existsSync(flyerPath)) {
      throw new Error(`Flyer not found: ${flyerPath || '(missing)'}`);
    }
  }

  const allSites = loadCredentials(credentialsPath);
  if (allSites.length === 0) {
    throw new Error('No valid credentials found. Use headers: Admin URL, User Name, Password');
  }

  const { unique: deduped, duplicates } = dedupeSites(allSites);

  const fromRow = Math.max(1, Math.floor(startRow) || 1);
  const inRange = deduped.filter((site) => site.row >= fromRow);
  const skippedBeforeRow = deduped.length - inRange.length;

  const skipSet = new Set(skipKeys);
  const sites = inRange.filter((site) => !skipSet.has(siteKey(site.url)));
  const skippedAlreadyDone = inRange.length - sites.length;

  const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

  const state = {
    status: 'running',
    mode,
    total: sites.length,
    done: 0,
    success: 0,
    failed: 0,
    current: null,
    active: [],
    skippedDuplicates: duplicates.length,
    skippedAlreadyDone,
    startRow: fromRow,
    skippedBeforeRow,
    failedSites: [],
    successSites: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  onProgress({ ...state, type: 'started' });

  const launchOptions = {
    channel: 'chrome',
    headless,
    args: ['--disable-extensions', '--mute-audio', '--disable-gpu'],
  };

  let browser = await chromium.launch(launchOptions);

  async function ensureBrowser() {
    if (browser?.isConnected()) return browser;
    await browser?.close().catch(() => {});
    browser = await chromium.launch(launchOptions);
    return browser;
  }

  let nextIndex = 0;

  async function openSiteContext() {
    const liveBrowser = await ensureBrowser();
    const context = await liveBrowser.newContext({ ignoreHTTPSErrors: true });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      const type = route.request().resourceType();
      if (
        /google-analytics|googletagmanager|googleadservices|doubleclick|facebook\.net|connect\.facebook|hotjar|clarity\.ms|fonts\.googleapis|fonts\.gstatic|gravatar\.com|s\.w\.org\/images\/core\/emoji|youtube\.com|youtu\.be|maps\.googleapis|maps\.gstatic|instagram\.com|tiktok\.com|recaptcha|hcaptcha|cookieyes|onetrust|cookielaw/.test(
          url
        )
      ) {
        return route.abort();
      }
      if (mode === 'test' && (type === 'media' || type === 'font' || type === 'texttrack')) {
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('dialog', (dialog) => {
      dialog.dismiss().catch(() => {});
    });
    if (mode === 'test') {
      page.setDefaultTimeout(12000);
      page.setDefaultNavigationTimeout(TEST_NAV_TIMEOUT);
    } else {
      page.setDefaultTimeout(45000);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    }
    return { context, page };
  }

  async function runSiteAction(page, site) {
    if (mode === 'disable') {
      const deletedCount = await deletePopupForSite(page, site);
      return { deletedCount };
    }
    if (mode === 'test') {
      const result = await testFlyerOnSite(page, site);
      if (!result.enabled) {
        throw new Error(`Flyer not found on ${result.publicUrl}`);
      }
      return { publicUrl: result.publicUrl };
    }
    await createPopupForSite(page, site, flyerPath, popupTitle);
    return {};
  }

  async function processSite(site) {
    const activeEntry = { row: site.row, name: site.name, url: site.url };
    state.active.push(activeEntry);
    state.current = state.active[0];
    onProgress({ ...state, type: 'site_started' });

    let context = null;
    let page = null;
    let retried = false;
    let timedOut = false;
    let timer = null;
    const budget = siteBudgetMs(mode);
    const startedAt = Date.now();

    async function resetSession() {
      await context?.close().catch(() => {});
      const opened = await openSiteContext();
      context = opened.context;
      page = opened.page;
    }

    try {
      const watchdog = new Promise((_, reject) => {
        timer = setInterval(() => {
          if (timedOut) return;
          const stopped = shouldStop();
          const overBudget = Date.now() - startedAt >= budget;
          if (!stopped && !overBudget) return;
          timedOut = true;
          context?.close().catch(() => {});
          reject(
            new Error(
              stopped
                ? 'Stopped while this site was still running'
                : `Timed out after ${Math.round(budget / 1000)}s — site did not finish (hung navigation or popup check)`
            )
          );
        }, 500);
      });

      const work = (async () => {
        await resetSession();
        try {
          return await runSiteAction(page, site);
        } catch (error) {
          const canRetry =
            mode === 'upload' && isTimeoutError(error) && !shouldStop() && !timedOut;
          if (!canRetry) throw error;

          retried = true;
          activeEntry.retrying = true;
          onProgress({ ...state, type: 'site_retry' });
          await resetSession();
          const again = await runSiteAction(page, site);
          activeEntry.retrying = false;
          return { ...(again || {}), retried: true };
        }
      })();

      const detail = await Promise.race([work, watchdog]);
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      state.success += 1;
      state.successSites.push({
        row: site.row,
        name: site.name,
        url: site.url,
        ...(detail || {}),
      });
      onProgress({ ...state, type: 'site_success' });
    } catch (error) {
      try {
        if (page && !page.isClosed()) {
          await takeScreenshot(page, path.join(screenshotsDir, `fail-row-${site.row}.png`));
        }
      } catch {
        // page already torn down
      }
      const failedError = timedOut
        ? new Error(
            shouldStop()
              ? 'Stopped while this site was still running'
              : `Timed out after ${Math.round(budget / 1000)}s — site did not finish (hung navigation or popup check)`
          )
        : error;
      const reason = humanizeJobError(failedError, mode);
      state.failed += 1;
      state.failedSites.push({
        row: site.row,
        name: site.name,
        url: site.url,
        publicUrl: mode === 'test' ? publicSiteUrl(site.url) : undefined,
        retried,
        error: retried ? `${reason} (retried once)` : reason,
      });
      onProgress({ ...state, type: 'site_failed' });
    } finally {
      if (timer) clearInterval(timer);
      state.done += 1;
      const idx = state.active.indexOf(activeEntry);
      if (idx >= 0) state.active.splice(idx, 1);
      state.current = state.active[0] || null;
      await context?.close().catch(() => {});
      onProgress({ ...state, type: 'site_finished' });
    }
  }

  // Each worker pulls the next unclaimed site, so a site is never handled twice.
  async function worker() {
    while (true) {
      if (shouldStop()) {
        state.status = 'stopped';
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= sites.length) return;
      await processSite(sites[index]);
    }
  }

  try {
    const workerCount = Math.max(1, Math.min(concurrency, sites.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    await browser.close().catch(() => {});
  }

  if (state.status === 'running') {
    state.status = 'completed';
  }
  state.finishedAt = new Date().toISOString();
  onProgress({ ...state, type: 'finished' });
  return state;
}

/** @deprecated use runPopupJob({ mode: 'upload', ... }) */
async function runPopupUpload(options) {
  return runPopupJob({ ...options, mode: 'upload' });
}

module.exports = { runPopupJob, runPopupUpload, loadCredentials, siteKey, publicSiteUrl };
