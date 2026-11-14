# Doto

**A simpler way to organise your day.**

![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8.3-646CFF?style=flat-square&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.3-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-Auth_%26_PostgreSQL-3ECF8E?style=flat-square&logo=supabase&logoColor=white)

---

## About Doto

Doto is a clean, minimal task management web application built to help you keep track of daily routines and deadlines without unnecessary clutter. Each user gets a private, session-protected workspace powered by Supabase Authentication and a PostgreSQL backend.

---

## Features

All features listed below are implemented in the current codebase:

- **Email & Password Authentication**: Sign up with full name and email, sign in, sign out, and restore active sessions automatically.
- **Email Verification Support**: Displays a confirmation prompt after signup when email verification is required by your Supabase project settings.
- **Password Recovery Flow**: Request a password reset email, verify recovery sessions (supporting implicit recovery tokens and `token_hash` links), set a new password in an isolated recovery view, and handle invalid or expired links gracefully.
- **Create & Manage Tasks**: Add new tasks with optional deadlines via a modal form.
- **Toggle Completion & Delete Tasks**: Mark tasks as completed or pending and remove tasks with per-row loading feedback and database refresh.
- **Search & Filter**:
  - Live search across task titles, categories, and deadlines (`Cmd/Ctrl + K` shortcut supported).
  - View filters for **All Tasks**, **Pending**, and **Completed**.
  - Priority filter controls (**High**, **Medium**, **Low**) and clear-filter controls.
- **Overview Counters & Weekly Strip**: Real-time totals for all, completed, and pending tasks, completion percentage, and a 7-day week strip.
- **Persistent Database Storage**: Tasks are stored in Supabase PostgreSQL (`public.tasks`) with loading, syncing, and retryable error states.
- **User-Specific Task Privacy**: Authenticated queries scope reads, inserts, updates, and deletes to the signed-in user's ID, backed by Supabase Row Level Security (RLS).
- **Responsive Interface**: Desktop sidebar and slide-over mobile navigation drawer with keyboard support (`Escape` closes modals or clears active search).

---

## Tech Stack

Verified from `package.json` and project configuration:

- **Language**: TypeScript (`^7.0.2`)
- **Build Tool & Dev Server**: Vite (`^8.3.0`)
- **Styling**: Tailwind CSS (`^4.3.3`) with `@tailwindcss/vite` (`^4.3.3`), Plus Jakarta Sans & JetBrains Mono fonts
- **Authentication & Database Client**: `@supabase/supabase-js` (`^2.119.0`)
- **Backend Platform**: Supabase Auth & Supabase PostgreSQL

*(Note: `package.json` also includes template packages such as `react`, `express`, `dotenv`, `@google/genai`, `lucide-react`, and `motion`, while the active application runs as a TypeScript + Vite SPA via `index.html` and `src/main.ts`.)*

---

## Getting Started

### Prerequisites

- **Node.js** (v18+ recommended) or **Bun** (`bun.lock` is included)
- A **Supabase** project with Email/Password Auth enabled and a `public.tasks` table

### Local Setup

1. **Clone the repository**

   ```bash
   git clone <your-repository-url>
   cd <repository-directory>
   ```

2. **Install dependencies**

   Using npm:

   ```bash
   npm install
   ```

   Or using Bun:

   ```bash
   bun install
   ```

3. **Configure environment variables**

   Copy `.env.example` to `.env` and add your Supabase project URL and public key:

   ```bash
   cp .env.example .env
   ```

4. **Start the development server**

   ```bash
   npm run dev
   ```

   The app runs on `http://localhost:3000` (`vite --port=3000 --host=0.0.0.0`).

### Available Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite development server on port `3000` |
| `npm run lint` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run build` | Build the production bundle into `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run clean` | Remove `dist/` and `server.js` |

---

## Environment Variables

Configure your local environment in `.env` using `.env.example` as a template. Never commit `.env` files or real credentials.

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Yes | Your Supabase Project URL (e.g. `https://your-project-id.supabase.co`). Trailing slashes or `/rest/v1` / `/auth/v1` suffixes are automatically normalized. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes (preferred) | Your Supabase public publishable key, safe for browser use when RLS is enabled. |
| `VITE_SUPABASE_ANON_KEY` | Fallback | Backward-compatible fallback if `VITE_SUPABASE_PUBLISHABLE_KEY` is not set. |
| `APP_URL` | Optional | Hosting URL placeholder from `.env.example` for environment/redirect fallbacks. |
| `GEMINI_API_KEY` | Optional | Unused by the current frontend task app; included as a placeholder in `.env.example`. |

> **Important:** Never place a Supabase `service_role` or `sb_secret_` key in any `VITE_*` variable or frontend file.

---

## Database Setup

Doto expects a `public.tasks` table in your Supabase PostgreSQL database matching these columns:

| Column | Type | Constraints / Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key (e.g. `default gen_random_uuid()`) |
| `user_id` | `uuid` | References `auth.users(id)`, `not null` |
| `title` | `text` | Task title, `not null` |
| `deadline` | `date` | Optional due date (`nullable`) |
| `completed` | `boolean` | Completion state, `not null default false` |
| `created_at` | `timestamptz` | Creation timestamp, `not null default now()` |

### Example Table & RLS Policies

Ensure Row Level Security (RLS) is enabled on `public.tasks` so users can only access and modify their own rows:

```sql
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  deadline date,
  completed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.tasks enable row level security;

create policy "Users can view their own tasks"
  on public.tasks for select
  using (auth.uid() = user_id);

create policy "Users can insert their own tasks"
  on public.tasks for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own tasks"
  on public.tasks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own tasks"
  on public.tasks for delete
  using (auth.uid() = user_id);
```

### Auth Redirect URL Configuration

In **Supabase Dashboard → Authentication → URL Configuration**, set your **Site URL** and add your local (`http://localhost:3000/**`) and deployed app origins to **Redirect URLs** so email confirmation and password recovery redirects return to your app.

---

## Project Structure

```text
.
├── .env.example          # Environment variable placeholders
├── .gitignore            # Excludes .env*, node_modules/, dist/, build/, .aistudio/
├── bun.lock              # Lockfile
├── index.html            # Application shell, auth views, dashboard layout, modals
├── metadata.json         # App metadata
├── package.json          # Scripts and dependencies
├── public/
│   └── assets/           # Static assets
├── src/
│   ├── index.css         # Tailwind CSS v4 import, theme tokens, custom animations
│   ├── main.ts           # UI state, auth/recovery routing, task CRUD handlers
│   └── supabase.ts       # Supabase client setup, key checks, auth & task queries
├── tsconfig.json         # TypeScript compiler configuration
└── vite.config.ts        # Vite config and env variable definitions
```

---

## Security

The current codebase implements several client-side protections, while database isolation relies on Supabase's server-side controls:

- **Frontend Secret Key Blocking**: `src/supabase.ts` rejects `sb_secret_` keys and legacy JWTs containing `"role": "service_role"` if mistakenly supplied in browser environment variables.
- **No Committed Credentials**: `.gitignore` excludes `.env*` files while keeping `.env.example` limited to placeholders.
- **Auth & Recovery Isolation**: Unauthenticated users cannot view `#dashboard-container`. During password recovery (`isPasswordRecoveryMode`), `INITIAL_SESSION`, `SIGNED_IN`, and `TOKEN_REFRESHED` events cannot override `#reset-password-card` or open the dashboard until the password update completes.
- **DOM Escaping & Safe Rendering**: User-supplied task titles and deadlines are escaped via `escapeHtml()` (escaping `&`, `<`, `>`, `"`, and `'`), dynamic attributes like `aria-label` and `data-id` are applied with `setAttribute()`, and status/error banners use `textContent` and `replaceChildren()`.
- **Dev-Only Diagnostics**: The Supabase connection diagnostic card is hidden by default and only initialized when `import.meta.env.DEV` is enabled.
- **Database Access Model**: All task operations require an active Supabase session and filter by `user_id`. True row-level isolation depends on properly configured Supabase RLS policies and project-level Auth rate limiting.

---

## Future Improvements

The following enhancements are planned ideas and are **not yet implemented**:

- Persist task priority (`High`, `Medium`, `Low`), categories, and streak counts in `public.tasks` (currently mapped with default values in the client).
- Inline editing for existing task titles and deadlines.
- Interactive date filtering tied to the 7-day calendar strip.
- Automated unit and end-to-end test coverage for authentication, password recovery, and task CRUD flows.

---

## License

No license has been specified for this project yet.
