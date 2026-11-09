import { expect, test } from './fixtures/runtime.js';

test('品牌重点色在浅色、深色及重复选择后保持清晰稳定', async ({ page, runtime }, testInfo) => {
  await page.route('**/.clawee/runtime/enterprise/platform-branding', route => route.fulfill({
    json: { sidebarLogoConfigured: false, sidebarCompactLogoConfigured: false, accentColor: '#F2E9EA' }
  }));
  await runtime.openApp(page);
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'brand');
  const openNavigation = page.getByRole('button', { name: '打开导航', exact: true });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  if (await openNavigation.isVisible()) await openNavigation.click();
  const selectedSidebar = page.locator('.sidebar-row[aria-current="page"]');
  await expect(selectedSidebar).toBeVisible();
  expect(await selectedSidebar.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('sidebar-selection.png'), fullPage: true });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const brandChoice = page.getByRole('radio', { name: '跟随品牌', exact: true });
  const selectedNav = page.locator('.settings-nav button[aria-current="page"]');

  for (const mode of ['浅色', '深色']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    for (let clickCount = 0; clickCount < 10; clickCount += 1) {
      await brandChoice.click();
      await expect(page.locator('html')).toHaveAttribute('data-accent', 'brand');
      await expect(brandChoice).toHaveAttribute('aria-checked', 'true');
    }
    const colors = await brandChoice.evaluate(element => {
      const style = getComputedStyle(element);
      const nav = document.querySelector('.settings-nav button[aria-current="page"]')!;
      const navStyle = getComputedStyle(nav);
      const indicator = getComputedStyle(nav, '::before');
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const luminance = (color: string) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(channel => {
          const normalized = channel / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      const probe = document.createElement('span');
      probe.style.color = 'var(--bg)';
      element.append(probe);
      const background = luminance(getComputedStyle(probe).color);
      probe.remove();
      const border = luminance(style.borderTopColor);
      return {
        borderContrast: (Math.max(border, background) + 0.05) / (Math.min(border, background) + 0.05),
        borderColor: style.borderTopColor,
        checkColor: style.color,
        swatchColor: getComputedStyle(element.querySelector('.settings-accent-swatch')!).backgroundColor,
        indicatorContent: indicator.content,
        navBackground: navStyle.backgroundColor,
        hoverBackground: getComputedStyle(nav.parentElement!).backgroundColor,
        overflow: document.documentElement.scrollWidth > window.innerWidth
      };
    });
    expect(colors.borderContrast).toBeGreaterThanOrEqual(3);
    expect(colors.borderColor).toBe(colors.checkColor);
    expect(colors.swatchColor).toBe('rgb(242, 233, 234)');
    expect(colors.indicatorContent).toBe('none');
    expect(colors.navBackground).not.toBe(colors.hoverBackground);
    expect(colors.overflow).toBe(false);
    await expect(selectedNav).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`brand-${mode === '浅色' ? 'light' : 'dark'}.png`), fullPage: true });
  }

  await page.getByRole('radio', { name: '紫色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'purple');
  await brandChoice.click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'brand');
  await page.getByRole('textbox', { name: '自定义重点色色值' }).fill('#0099ff');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom');
  await brandChoice.click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'brand');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'brand');
});
