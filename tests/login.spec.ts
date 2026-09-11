import * as fs from 'fs';
import * as path from 'path';
import * as xlsx from 'xlsx';
import { test, expect, Page } from '@playwright/test';
import process from 'process';

const workbookPath = path.resolve(process.cwd(), 'admin url.xlsx');

function loadCredentials() {
  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Missing credentials file: ${workbookPath}`);
  }

  const workbook = xlsx.readFile(workbookPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' });

  return rows
    .map((row) => {
      const url = String(
        row.url || row.URL || row['Admin URL'] || row.site || row.Site || ''
      ).trim();
      const username = String(
        row.username || row.Username || row['User Name'] || row.user || row.User || ''
      ).trim();
      const password = String(
        row.password || row.Password || row.pass || row.Pass || ''
      ).trim();
      return { url, username, password };
    })
    .filter((record) => record.url && record.username && record.password);
}

function wpAdminUrl(fromUrl: string) {
  const parsed = new URL(fromUrl);
  return `${parsed.origin}/wp-admin/`;
}

async function dismissAdminEmailScreen(page: Page, adminUrl: string) {
  const remindMeLater = page.getByRole('link', { name: /Remind me later/i });
  const emailCorrect = page.getByRole('button', { name: /The email is correct/i });

  if (await remindMeLater.isVisible({ timeout: 8000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      remindMeLater.click(),
    ]);
    await page.waitForTimeout(1500);
  } else if (await emailCorrect.isVisible({ timeout: 2000 }).catch(() => false)) {
    await emailCorrect.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  // Only force /wp-admin/ if still stuck on the email verification screen
  const stillOnEmailScreen =
    (await page.getByRole('heading', { name: /Administration email verification/i }).isVisible({ timeout: 2000 }).catch(() => false)) ||
    (await remindMeLater.isVisible({ timeout: 1000 }).catch(() => false));

  if (stillOnEmailScreen || !(await page.locator('#adminmenu').isVisible({ timeout: 5000 }).catch(() => false))) {
    await page.goto(adminUrl, { waitUntil: 'domcontentloaded' }).catch(async () => {
      await page.waitForTimeout(2000);
      await page.goto(adminUrl, { waitUntil: 'load' }).catch(() => {});
    });
  }

  if (await remindMeLater.isVisible({ timeout: 3000 }).catch(() => false)) {
    await remindMeLater.click();
    await page.waitForTimeout(1000);
    await page.goto(adminUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  await page.locator('#adminmenu').waitFor({ state: 'visible', timeout: 30000 });
}

async function takeScreenshot(page: Page, filePath: string) {
  // Heavy WP admin pages can hang forever waiting for fonts; never fail the test for that
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
    console.warn(`Screenshot skipped (font/page hang): ${filePath}`);
  }
}

const credentials = loadCredentials();

if (credentials.length === 0) {
  throw new Error('No valid credentials found in the Excel file. Use headers: url, username, password');
}

// Run a single site once, then stop
const sitesToRun = credentials.slice(0, 1);

for (const [index, { url, username, password }] of sitesToRun.entries()) {
  test(`Login to WordPress [row ${index + 1}]`, async ({ page }) => {
    test.setTimeout(180000);
    const adminUrl = wpAdminUrl(url);

    await page.goto(url);
    await page.locator('#user_login').fill(username);
    await page.locator('#user_pass').fill(password);
    await page.locator('#wp-submit').click();

    await dismissAdminEmailScreen(page, adminUrl);

    const popupBuilder = page.locator('div.wp-menu-name', { hasText: 'Popup Builder' });
    await popupBuilder.waitFor({ state: 'visible', timeout: 20000 });
    await popupBuilder.click();
    await page.waitForLoadState('domcontentloaded');

    // Open Image popup editor directly — avoids blank Add New type-picker page
    const imageCreateUrl = new URL(
      '/wp-admin/post-new.php?post_type=popupbuilder&sgpb_type=image',
      adminUrl
    ).toString();

    await page.goto(imageCreateUrl, { waitUntil: 'domcontentloaded' });

    // If still blank / redirected to type picker, click Image box or retry once
    const imageBox = page
      .locator('div.sgpb-box.sgpb-box-active.sgpb-margin-bottom-30.sgpb-position-relative')
      .first();

    if (await imageBox.isVisible({ timeout: 8000 }).catch(() => false)) {
      const redirectUrl = await imageBox.getAttribute('data-redirect-url');
      if (redirectUrl) {
        await page.goto(redirectUrl, { waitUntil: 'domcontentloaded' });
      } else {
        await imageBox.click({ force: true });
        await page.waitForLoadState('domcontentloaded');
      }
    } else if (!page.url().includes('sgpb_type=image')) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.goto(imageCreateUrl, { waitUntil: 'domcontentloaded' });
    }

    const titleInput = page.locator('#titlewrap #title');
    await titleInput.waitFor({ state: 'visible', timeout: 20000 });
    await titleInput.fill('Weekend Special');

    const uploadImageButton = page.locator('#js-upload-image-button');
    await uploadImageButton.waitFor({ state: 'visible', timeout: 15000 });
    await uploadImageButton.click({ force: true });

    const mediaModal = page.locator('.media-modal');
    await mediaModal.waitFor({ state: 'visible', timeout: 20000 });

    const uploadFilesTab = page.locator('#menu-item-upload');
    await uploadFilesTab.waitFor({ state: 'attached', timeout: 15000 });
    await uploadFilesTab.click({ force: true });

    const promoImagePath = path.resolve(process.cwd(), 'assets', 'Weekend_Offer.png');
    const fileInput = page.locator('.media-modal input[type="file"]').last();
    await fileInput.setInputFiles(promoImagePath);

    // Wait for upload to finish before switching tabs
    await page
      .locator('.media-uploader-status.uploading')
      .waitFor({ state: 'hidden', timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    const mediaLibraryTab = page.locator('#menu-item-browse');
    await mediaLibraryTab.waitFor({ state: 'attached', timeout: 15000 });
    await mediaLibraryTab.click({ force: true });
    await page.waitForTimeout(1000);

    const firstImage = page
      .locator('.media-modal li.attachment[aria-label="Weekend_Offer"]')
      .or(page.locator('.media-modal li.attachment').first())
      .first();
    await firstImage.waitFor({ state: 'visible', timeout: 30000 });

    // WP media grid selects via the preview / checkbox area
    const selectTarget = firstImage.locator('.js--select-attachment, .attachment-preview, .thumbnail').first();
    if (await selectTarget.count()) {
      await selectTarget.click({ force: true });
    } else {
      await firstImage.click({ force: true });
    }

    // Retry once if selection did not stick
    if ((await firstImage.getAttribute('aria-checked')) !== 'true') {
      await firstImage.click({ force: true });
      await page.waitForTimeout(500);
    }

    await expect(firstImage).toHaveAttribute('aria-checked', 'true', { timeout: 15000 });

    const chooseImageButton = page.locator(
      'button.media-button-select.button-primary',
      { hasText: 'Choose Image' }
    );
    await chooseImageButton.waitFor({ state: 'visible', timeout: 15000 });
    await expect(chooseImageButton).toBeEnabled({ timeout: 20000 });
    await chooseImageButton.click({ force: true });

    await page.waitForTimeout(2000);

    const publishButton = page.locator('#publish');
    await publishButton.waitFor({ state: 'visible', timeout: 20000 });
    await expect(publishButton).toBeEnabled({ timeout: 15000 });
    await publishButton.scrollIntoViewIfNeeded();
    await publishButton.click({ force: true });
    await page.waitForLoadState('domcontentloaded');

    await page.waitForTimeout(2000);

    const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

    await takeScreenshot(page, path.join(screenshotsDir, `dashboard-row-${index + 1}.png`));

    await page.waitForTimeout(5000);
  });
}
