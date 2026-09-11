import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export type PdfTextPage = {
  pageNumber: number;
  text: string;
  itemCount: number;
};

function getItemText(item: unknown): string {
  if (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof (item as { str?: unknown }).str === 'string'
  ) {
    return (item as { str: string }).str;
  }

  return '';
}

function getDocumentOptions(bytes: Buffer) {
  return {
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
  };
}

export async function extractPdfText(
  bytes: Buffer,
): Promise<PdfTextPage[]> {
  const pdf = await pdfjsLib.getDocument(
    getDocumentOptions(bytes),
  ).promise;

  const pages: PdfTextPage[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();

    const text = content.items
      .map(getItemText)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    pages.push({
      pageNumber,
      text,
      itemCount: content.items.length,
    });
  }

  return pages;
}

export async function renderPageForOcr(
  bytes: Buffer,
  pageNumber: number,
): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');

  const pdf = await pdfjsLib.getDocument(
    getDocumentOptions(bytes),
  ).promise;

  const page = await pdf.getPage(pageNumber);

  const viewport = page.getViewport({
    scale: 2,
  });

  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  await page.render({
    canvasContext: context as never,
    viewport,
    canvas: canvas as never,
  }).promise;

  return canvas.toBuffer('image/png');
}
