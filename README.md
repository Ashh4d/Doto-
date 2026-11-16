# Doto

**Less chaos. More done.**

![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8.3-646CFF?style=flat-square&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.3-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-Auth_%26_PostgreSQL-3ECF8E?style=flat-square&logo=supabase&logoColor=white)

A clean, minimal daily task management web application built with TypeScript, Tailwind CSS, Vite, and Supabase.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Key Features](#key-features)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [How the Application Works](#how-the-application-works)
- [Local Installation and Setup](#local-installation-and-setup)
- [Required Environment Variables](#required-environment-variables)
- [Database Setup](#database-setup)
- [Deployment](#deployment)
- [Project Structure](#project-structure)

---

## Project Overview

Doto is designed to help users organize daily routines and track deadlines without visual clutter. Each signed-in user gets a private dashboard backed by Supabase Authentication and a PostgreSQL `public.tasks` table, with instant UI feedback for completing and deleting tasks and responsive support across desktop and mobile viewports.

---

## Key Features

- **Email & Password Authentication**: Sign up with your name, email, and password, sign in, sign out, and restore active sessions automatically across refreshes.
- **Email Verification & Password Reset**: Displays an inbox verification prompt after sign-up when email confirmation is enabled, and supports full password recovery (handling recovery links, isolated reset-password mode, and expired/invalid link errors).
- **Customizable Display Names**: Update your display name anytime from the sidebar profile section using a validated modal (trimmed, required, up to 50 characters), persisted in Supabase Auth `user_metadata` and reflected in the sidebar and time-of-day dashboard greeting (with clean fallbacks when unset).
- **Profile Popover**: Keeps your email address hidden from the default sidebar view; clicking your avatar or display name opens a popover displaying your display name and registered email fetched live from the active Supabase session, closable via its close controls, clicking outside, or pressing `Escape`.
- **Task Creation, Completion & Deletion**: Add routines with optional due dates via modal (`Add Task`), toggle completion status, and remove tasks—with live overview totals, completion percentage, and sidebar view counters.
- **Search, Filters & Deadlines**: Filter by **All Tasks**, **Pending**, or **Completed**, filter by priority (`High`, `Medium`, `Low`), search across titles, categories, and deadlines (`Cmd/Ctrl + K`), and view a 7-day calendar strip.
- **Instant Optimistic UI Updates**: Marking a task complete/incomplete or deleting a task updates the UI, counters, filters, and progress percentage immediately while syncing with Supabase in the background—automatically preventing duplicate clicks and rolling back with an error toast if a request fails.
- **Supabase Cloud Database & User-Specific Data Protection**: Every task query requires an authenticated Supabase session, scopes reads/writes to the signed-in user's ID, enforces Supabase Row Level Security (RLS), escapes rendered HTML, and blocks secret/`service_role` keys in client builds.

---

## Screenshots

> Add your own screenshots to a folder such as `public/screenshots/` and update the image paths below.

| View | Preview |
| --- | --- |
| **Sign In & Authentication** | `<!-- Add screenshot: ![Sign In Screen](./public/screenshots/auth.png) -->` *Placeholder: Login / Sign Up card* |
| **Dashboard Overview** | `<!-- Add screenshot: ![Dashboard](./public/screenshots/dashboard.png) -->` *Placeholder: Desktop dashboard with anchored sidebar and task timeline* |
| **Profile Popover & Edit Display Name** | `<!-- Add screenshot: ![Profile Popover](./public/screenshots/profile-popover.png) -->` *Placeholder: Sidebar profile popover and Edit Display Name modal* |
| **Mobile View** | `<!-- Add screenshot: ![Mobile View](./public/screenshots/mobile.png) -->` *Placeholder: Responsive mobile header and slide-over sidebar drawer* |

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Language** | TypeScript (`^7.0.2`) |
| **Bundler & Dev Server** | Vite (`^8.3.0`) |
| **Styling** | Tailwind CSS (`^4.3.3`) via `@tailwindcss/vite`, Plus Jakarta Sans & JetBrains Mono |
| **Authentication & Database** | `@supabase/supabase-js` (`^2.119.0`) — Supabase Auth & PostgreSQL |

---

## How the Application Works

1. **Session & Route Protection (`src/main.ts`, `src/supabase.ts`)**
   - On page load, Doto inspects URL parameters for auth errors or password recovery tokens (`type=recovery`, `token_hash`, or implicit recovery tokens) and checks the current Supabase session via `getSession()`.
   - Unauthenticated users only see `#auth-container` (Sign In, Create Account, Forgot Password, Email Verification, or Set New Password), while `#dashboard-container` remains hidden.
   - During password recovery, `isPasswordRecoveryMode` prevents `INITIAL_SESSION` or `SIGNED_IN` events from opening the dashboard until `updateUserPassword()` completes.

2. **Profile, Display Name & Popover**
   - `updateUserProfileUI()` resolves the display name from `user.user_metadata.display_name` (falling back to `full_name` / `name`, or `'Doto User'` in the sidebar and `'Friend'` in the greeting).
   - Editing the display name calls `supabase.auth.updateUser({ data: { display_name } })` after validating an active session so users can only update their own metadata.
   - Clicking the sidebar profile button opens `#profile-popover` and reads `session.user.email` directly from `getSession()`, clearing it when the popover closes.

3. **Tasks & Optimistic Updates**
   - Signing in triggers `fetchUserTasks()` to load rows from `public.tasks` ordered by `created_at` descending.
   - Toggling completion or deleting a task updates the local `tasks` array, counters, active filters, and completion percentage immediately (`pendingTaskIds` blocks duplicate clicks while the request is in flight).
   - `updateUserTaskCompletion()` or `deleteUserTask()` runs in the background without re-fetching the entire list. If the database request fails, Doto restores the previous task state in order and displays a toast notification.

---

## Local Installation and Setup

### Prerequisites

- **Node.js** (v18 or higher recommended) and **npm** (or **Bun**)
- A free **Supabase** account and project

### Steps

1. **Clone the repository**

   ```bash
   git clone <your-repository-url>
   cd <repository-folder>
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Create your local `.env` file**

   ```bash
   cp .env.example .env
   ```

   Open `.env` and replace the placeholders with your Supabase Project URL and public publishable (or anon) key.

4. **Set up the Supabase database & auth URLs**

   Follow the [Database Setup](#database-setup) section below to create the `public.tasks` table, enable Row Level Security, and configure your redirect URLs.

5. **Run the development server**

   ```bash
   npm run dev
   ```

   Open `http://localhost:3000` in your browser.

### Available Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite dev server on port `3000` |
| `npm run lint` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run build` | Compile the production bundle into `dist/` |
| `npm run preview` | Preview the production `dist/` build locally |
| `npm run clean` | Remove `dist/` and `server.js` |

---

## Required Environment Variables

Use `.env.example` as a reference. Never commit `.env` files or real credentials to Git.

```env
VITE_SUPABASE_URL="https://your-project-id.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="your-supabase-publishable-key"
VITE_SUPABASE_ANON_KEY="your-anon-public-key"
```

| Variable | Required | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Yes | Your Supabase Project URL (`https://<project-id>.supabase.co`). |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes (preferred) | Public browser-safe key from **Supabase Dashboard → Project Settings → API**. |
| `VITE_SUPABASE_ANON_KEY` | Fallback | Used only if `VITE_SUPABASE_PUBLISHABLE_KEY` is not set. |
| `APP_URL` | Optional | Optional fallback URL placeholder defined in `.env.example`. |
| `GEMINI_API_KEY` | Optional | Placeholder present in `.env.example`; not used by the Doto frontend. |

> **Security Note:** Never put a Supabase `service_role` or `sb_secret_` key in `.env` `VITE_*` variables or frontend code. Doto explicitly blocks secret keys if detected in browser configuration.

---

## Database Setup

Run the following SQL in your **Supabase Dashboard → SQL Editor** to create the `public.tasks` table and enable Row Level Security so every user can only read, create, update, and delete their own tasks:

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

### Auth URL Configuration

In **Supabase Dashboard → Authentication → URL Configuration**:

1. Set **Site URL** to your app URL (e.g. `http://localhost:3000` for local development, or your production URL once deployed).
2. Add both `http://localhost:3000/**` and `https://<your-deployed-domain>/**` to **Redirect URLs** so email verification and password reset links redirect back to Doto cleanly.

---

## Deployment

Doto builds into a static frontend bundle (`dist/`) via `npm run build` and can be deployed to any static hosting platform such as **Vercel**, **Netlify**, or **Cloudflare Pages**.

### Deploying on Vercel

1. Push your repository to GitHub (confirm `.env` is ignored by `.gitignore`).
2. Import the repository in **Vercel**:
   - **Framework Preset**: Vite
   - **Install Command**: `npm install`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. Add your environment variables in **Vercel → Project Settings → Environment Variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` (or `VITE_SUPABASE_ANON_KEY`)
4. Deploy the project, then add the live `https://...` deployment URL to **Supabase → Authentication → URL Configuration → Redirect URLs** (and update **Site URL** if needed).

---

## Project Structure

```text
.
├── .env.example          # Safe placeholder environment variables
├── .gitignore            # Ignores .env*, node_modules/, dist/, build/, .aistudio/
├── index.html            # Auth cards, dashboard layout, sidebar, modals, popover
├── metadata.json         # Application metadata
├── package.json          # Project dependencies and npm scripts
├── package-lock.json     # npm dependency lockfile
├── public/               # Static public directory
├── src/
│   ├── index.css         # Tailwind CSS v4 setup, theme styling, animations
│   ├── main.ts           # UI state, auth/recovery routing, optimistic task handlers
│   └── supabase.ts       # Supabase client init, key checks, auth & task queries
├── tsconfig.json         # TypeScript compiler configuration
└── vite.config.ts        # Vite configuration and environment injection
```
