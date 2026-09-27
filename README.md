# GameTable

Plataforma SaaS multi-restaurante para convertir la espera en una experiencia multijugador. El primer juego es Burger Rush: partidas de 2 a 8 jugadores, control desde el móvil, pantalla pública y ranking.

## Arranque local

Requisitos: Node.js 20+, Docker Desktop y npm 10+.

```bash
copy .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

Panel: `http://localhost:5173`
API: `http://localhost:4000/health`

Después del seed, acceso demo: `admin@gametable.local` / `GameTableDemo2026!`. Cambia o elimina ese usuario antes de cualquier entorno compartido.

## Flujo de juego

1. El operador inicia sesión en el panel y crea una partida.
2. Abre la pantalla con el código y muestra el QR.
3. Cada jugador entra desde `/join/CODIGO`, escribe su nickname y controla la arena desde el teléfono.
4. La pantalla recibe los participantes y las acciones por Socket.IO; el backend valida jugador, sala y acción.

## Arquitectura

`apps/api` contiene Express, Socket.IO, Zod, JWT, rate limiting y Prisma. El esquema PostgreSQL es multi-tenant y relaciona restaurantes, usuarios, dispositivos, jugadores, partidas y eventos de puntuación. Redis se usa como adaptador de Socket.IO para varias réplicas del backend.

`apps/web` contiene panel autenticado, pantalla TV, controlador móvil PWA y la arena Burger Rush en Phaser. La pantalla genera un QR real desde la API.

## Producción

Configura secretos reales, PostgreSQL administrado, Redis administrado, `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `WEB_ORIGIN` y `VITE_API_URL` con los dominios públicos, HTTPS, backups, observabilidad, Cloudinary y Wompi/Stripe. Despliega `apps/web` en Vercel usando `vercel.json` y `apps/api` como contenedor en Railway o Render usando `apps/api/Dockerfile`; el backend escucha `PORT` si el proveedor la define. Cloudflare debe terminar TLS y apuntar al frontend y API con subdominios separados.

Las credenciales de Cloudinary, Wompi, PostgreSQL, Redis y Cloudflare son secretos del proveedor: se configuran en el panel de despliegue y no se guardan en Git. Los archivos `.env.example` solo documentan sus nombres.

Stripe se integra mediante Checkout, Customer Portal y el endpoint firmado `/api/webhooks/stripe`. Antes de activarlo, crea los cuatro precios recurrentes en Stripe, configura sus Price IDs como `STRIPE_PRICE_*` y registra los eventos `checkout.session.completed`, `customer.subscription.updated` y `customer.subscription.deleted` hacia ese endpoint.

## Validación

```bash
npm run db:generate
npm run db:migrate:deploy
npm run typecheck
npm test
npm run build
```

`db:push` es solo para desarrollo local. Railway/Render debe ejecutar `npm run db:migrate:deploy` antes de arrancar la API.
