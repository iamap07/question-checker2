import 'next-auth'; declare module 'next-auth'{interface Session{accessToken?:string;googleSubject?:string}} declare module 'next-auth/jwt'{interface JWT{accessToken?:string;googleSubject?:string}}
