import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import type { Session } from 'next-auth';

import { parseGoogleSheetUrl } from '@/lib/google/url';
import {
  createScan,
  upsertUser,
} from '@/lib/database/repository';
import { inngest } from '@/lib/queue/inngest';
import { authOptions } from '@/lib/google/nextauth';

type AppSession = Session & {
  accessToken?: string;
  googleSubject?: string;
};

const RequestSchema = z.object({
  sheetUrl: z
    .string()
    .url()
    .min(1),
});

function isOAuthConfigured(): boolean {
  return Boolean(
    process.env.NEXTAUTH_SECRET &&
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET,
  );
}

export async function POST(
  req: Request,
) {
  try {
    const body =
      await req.json();

    const {
      sheetUrl,
    } =
      RequestSchema.parse(
        body,
      );

    /*
     * Validate and parse the Google Sheet URL.
     */
    const {
      spreadsheetId,
      gid,
    } =
      parseGoogleSheetUrl(
        sheetUrl,
      );

    /*
     * Authentication is optional for public sheets.
     * Only attempt to read the session when the
     * required OAuth configuration exists.
     */
    let session:
      | AppSession
      | null = null;

    if (
      isOAuthConfigured()
    ) {
      try {
        const authenticated =
          await getServerSession(
            authOptions,
          );

        session =
          authenticated as
            | AppSession
            | null;
      } catch (error) {
        /*
         * A public scan should not fail merely because
         * OAuth is not available/configured correctly.
         */
        console.warn(
          'OAuth session unavailable:',
          error,
        );

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
     * Public scans receive a temporary token.
     * Authenticated users do not need one.
     */
    const publicToken =
      session?.user?.email
        ? null
        : crypto.randomBytes(
            32,
          ).toString(
            'base64url',
          );

    const tokenHash =
      publicToken
        ? crypto
            .createHash(
              'sha256',
            )
            .update(
              publicToken,
            )
            .digest(
              'hex',
            )
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

    /*
     * Start the asynchronous discovery pipeline.
     */
    await inngest.send({
      name:
        'scan/discover.requested',

      data: {
        scanId:
          scan.id,

        sheetUrl,

        userId:
          user.id,

        accessToken:
          session?.accessToken ??
          undefined,
      },
    });

    return NextResponse.json(
      {
        id:
          scan.id,

        token:
          publicToken,

        authenticated:
          Boolean(
            session?.user
              ?.email,
          ),
      },
    );
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
