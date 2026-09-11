import { NextResponse } from 'next/server';
import { getScanMatches } from '@/lib/database/repository';
import {
  toCsv,
  toJson,
  toPdf,
  toXlsx,
  type ReportMatch,
} from '@/lib/export/report';

const CONFLICT_CATEGORIES = new Set([
  'EXACT_DUPLICATE',
  'NEAR_DUPLICATE',
  'SAME_STRUCTURE_DIFFERENT_VALUES',
]);

type ScanMatchRow = {
  question_a?: {
    documents?: {
      filename?: string | null;
    } | null;
    question_number?: string | null;
    page_number?: number | null;
  } | null;
  question_b?: {
    documents?: {
      filename?: string | null;
    } | null;
    question_number?: string | null;
    page_number?: number | null;
  } | null;
  final_score: number;
  category: string;
  confidence: number;
  reason: string;
};

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const view = new Uint8Array(buffer);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const format = url.searchParams.get('format') ?? 'csv';
    const includeAll = url.searchParams.get('conflicts') === 'false';

    const matches = (await getScanMatches(id)) as ScanMatchRow[];

    const filtered = includeAll
      ? matches
      : matches.filter((match) => CONFLICT_CATEGORIES.has(match.category));

    const rows: ReportMatch[] = filtered.map((match) => ({
      pdfA: match.question_a?.documents?.filename ?? 'PDF A',
      questionA: match.question_a?.question_number ?? '',
      pageA: match.question_a?.page_number ?? 0,
      pdfB: match.question_b?.documents?.filename ?? 'PDF B',
      questionB: match.question_b?.question_number ?? '',
      pageB: match.question_b?.page_number ?? 0,
      similarity: match.final_score,
      category: match.category,
      confidence: match.confidence,
      reason: match.reason,
    }));

    if (format === 'json') {
      return new NextResponse(toJson(rows), {
        headers: {
          'content-type': 'application/json',
          'content-disposition:
            'attachment; filename="similarity-report.json"',
        },
      });
    }

    if (format === 'xlsx') {
      const buffer = await toXlsx(rows);

      return new NextResponse(toArrayBuffer(buffer), {
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition:
            'attachment; filename="similarity-report.xlsx"',
        },
      });
    }

    if (format === 'pdf') {
      const buffer = await toPdf(rows);

      return new NextResponse(toArrayBuffer(buffer), {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition:
            'attachment; filename="similarity-report.pdf"',
        },
      });
    }

    return new NextResponse(toCsv(rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition:
          'attachment; filename="similarity-report.csv"',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
