import { expect, type Page } from '@playwright/test';

// 一页有效 PDF；动态计算偏移，避免只检查 %PDF 签名的假文件。
export function previewPdfFixture(): Buffer {
  const content = '0 0.5 0 rg 40 100 220 120 re f\nBT /F1 24 Tf 40 250 Td (Clawee PDF Preview) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 360] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export async function expectPdfPreviewLoaded(page: Page): Promise<void> {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      const viewer = frame.locator('pdf-viewer');
      if (await viewer.count() === 0) continue;
      const loaded = await viewer.evaluate(element => {
        const toolbar = element.shadowRoot?.querySelector('viewer-toolbar') as (Element & { docLength?: number }) | null;
        return toolbar?.docLength;
      });
      if (loaded === 1) return true;
    }
    return false;
  }, { timeout: 20_000, message: '内置 PDF 查看器应成功解析一页有效 PDF' }).toBe(true);
}
