// Vercel: el catch-all de api/ no atrapa rutas anidadas; esta cubre /api/betano/* (lecturas de Betano).
export { handler as default } from '../../server.mjs';
