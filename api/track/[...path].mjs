// Vercel: el catch-all de api/ no atrapa rutas anidadas; esta cubre /api/track/* (seguimiento de apuestas).
export { handler as default } from '../../server.mjs';
