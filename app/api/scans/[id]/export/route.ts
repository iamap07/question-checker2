import { NextResponse } from 'next/server';
import { getScanMatches } from '@/lib/database/repository';
import {
  toCsv,
  toJson,
  toPdf,
  toXlsx,
} from '@/lib/export/report';

type ScanMatch = {
  question_a?: {
    documents?: {
      filename?: string | null;
    } | null;
    question_number?: string | number | null;
    page_number?: number | null;
  } | null;

  question_b?: {
    documents?: {
      filename?: string | null;
    } | null;
    question_number?: string | number | null;
    page_number?: number | null;
  } | null;

  final_score: number;
  category: string;
  confidence: number;
  reason: string;
};

type ReportRow = {
  pdfA: string;
  questionA: string;
  pageA: number;
  pdfB: string;
  questionB: string;
  pageB: number;
  similarity: number;
  category: string;
  confidence: number;
  reason: string;
};

const CONFLICT_CATEGORIES = new Set([
  'EXACT_DUPLICATE',
  'NEAR_DUPLICATE',
  'SAME_STRUCTURE_DIFFERENT_VALUES',
]);

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);
  return bytes.buffer;
}

export async function GET(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
  },
) {
  try {
    const { id } = await params;

    const url = new URL(req.url);
    const format = url.searchParams.get('format') ?? 'csv';
    const conflictsOnly =
      url.searchParams.get('conflicts') !== 'false';

    const rawMatches = await getScanMatches(id);
    const matches = rawMatches as ScanMatch[];

    const filteredMatches = conflictsOnly
      ? matches.filter((match) =>
          CONFLICT_CATEGORIES.has(match.category),
        )
      : matches;

    const rows: ReportRow[] = filteredMatches.map((match) => ({
      pdfA: match.question_a?.documents?.filename ?? 'PDF A',
      questionA: String(
        match.question_a?.question_number ?? '',
      ),
      pageA: match.question_a?.page_number ?? 0,

      pdfB: match.question_b?.documents?.filename ?? 'PDF B',
      questionB: String(
        match.question_b?.question_number ?? '',
      ),
      pageB: match.question_b?.page_number ?? 0,

      similarity: match.final_score,
      category: match.category,
      confidence: match.confidence,
      reason: match.reason,
    }));

    if (format === 'json') {
      return new NextResponse(toJson(rows), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition':
            'attachment; filename="similarity-report.json"',
        },
      });
    }

    if (format === 'xlsx') {
      const buffer = await toXlsx(rows);
      const body = bufferToArrayBuffer(buffer);

      return new NextResponse(body, {
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition':
            'attachment; filename="similarity-report.xlsx"',
        },
      });
    }

    if (format === 'pdf') {
      const buffer = await toPdf(rows);
      const body = bufferToArrayBuffer(buffer);

      return new NextResponse(body, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition':
            'attachment; filename="similarity-report.pdf"',
        },
      });
    }

    return new NextResponse(toCsv(rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition':
          'attachment; filename="similarity-report.csv"',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      {
        status: 500,
      },
    );
  }
}
