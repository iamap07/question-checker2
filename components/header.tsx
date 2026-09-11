'use client';

import { useEffect, useState } from 'react';
import { Button } from './ui';

type AuthState = {
  authenticated: boolean;
  name?: string | null;
  email?: string | null;
};

export function Header() {
  const [auth, setAuth] =
    useState<AuthState>({
      authenticated: false,
    });

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const response = await fetch(
          '/api/auth/session',
          {
            cache: 'no-store',
          },
        );

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as {
          user?: {
            name?: string | null;
            email?: string | null;
          } | null;
        };

        if (cancelled) {
          return;
        }

        if (data.user) {
          setAuth({
            authenticated: true,
            name: data.user.name,
            email: data.user.email,
          });
        }
      } catch {
        if (!cancelled) {
          setAuth({
            authenticated: false,
          });
        }
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  function connectGoogle() {
    window.location.href =
      '/api/auth/signin/google';
  }

  function signOut() {
    window.location.href =
      '/api/auth/signout?callbackUrl=/';
  }

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/85 px-5 py-4 backdrop-blur md:ml-64">
      <div>
        <div className="text-sm text-slate-500">
          Question Paper Similarity Checker
        </div>

        <div className="font-bold">
          Audit your question bank with confidence
        </div>
      </div>

      {auth.authenticated ? (
        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <div className="text-sm font-semibold">
              {auth.name ?? 'Google User'}
            </div>

            {auth.email ? (
              <div className="text-xs text-slate-500">
                {auth.email}
              </div>
            ) : null}
          </div>

          <Button
            className="bg-slate-900 hover:bg-slate-700"
            onClick={signOut}
          >
            Sign out
          </Button>
        </div>
      ) : (
        <Button onClick={connectGoogle}>
          Connect Google
        </Button>
      )}
    </header>
  );
}
