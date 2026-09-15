import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getServerSession } from 'next-auth';

import { parseGoogleSheetUrl } from '@/lib/google/url';
import {
  createScan,
  upsertUser,
} from '@/lib/database/repository';
import { inngest } from '@/lib/queue/inngest';
import { authOptions } from '@/lib/google/nextauth';

const RequestSchema = z.object({
  sheetUrl: z.string().url(),
});

function oauthIsConfigured(): boolean {
  return Boolean(
    process.env.NEXTAUTH_SECRET &&
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET,
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const { sheetUrl } =
      RequestSchema.parse(body);

    /*
     * Validate the Google Sheet URL before creating
     * any database records.
     */
    const { spreadsheetId, gid } =
      parseGoogleSheetUrl(sheetUrl);

    let session: Awaited<
      ReturnType<typeof getServerSession>
    > = null;

    /*
     * IMPORTANT:
     * Public sheets must work even when Google OAuth
     * has not been configured yet.
     */
    if (oauthIsConfigured()) {
      try {
        session =
          await getServerSession(
            authOptions,
          );
      } catch {
        /*
         * Ignore authentication configuration
         * failures for public/anonymous scans.
         */
        session = null;
      }
    }

    const anonymousId =
      crypto.randomUUID();

    const email =
      session?.user?.email ??
      `public-${anonymousId}@anonymous.invalid`;

    const user =
      await upsertUser({
        email,
        name:
          session?.user?.name ??
          'Public User',
        image:
          session?.user?.image ??
          undefined,
        googleSubject:
          session?.googleSubject ??
          undefined,
      });

    /*
     * Public scans receive a random access token.
     * This token is returned to the browser and is
     * required to access the scan without login.
     */
    const publicToken =
      session?.user?.email
        ? null
        : crypto.randomBytes(32).toString(
            'base64url',
          );

    const tokenHash =
      publicToken
        ? crypto
            .createHash('sha256')
            .update(publicToken)
            .digest('hex')
        : null;

    const scan =
      await createScan(
        user.id,
        {
          spreadsheetId,
          gid,
          sheetUrl,
          accessTokenHash:
            tokenHash,
        },
      );

    await inngest.send({
      name:
        'scan/discover.requested',

      data: {
        scanId: scan.id,
        sheetUrl,
        userId: user.id,

        /*
         * OAuth access token is only forwarded
         * when the user is actually authenticated.
         */
        accessToken:
          session?.accessToken ??
          undefined,
      },
    });

    return NextResponse.json({
      id: scan.id,
      token: publicToken,
      authenticated:
        Boolean(
          session?.user?.email,
        ),
    });
  } catch (error) {
    console.error(
      'Create scan error:',
      error,
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      {
        status: 400,
      },
    );
  }
}
