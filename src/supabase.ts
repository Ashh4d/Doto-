/**
 * Supabase Client Initialization & Auth Helper Module
 * Real authentication via Supabase Auth (@supabase/supabase-js)
 */

import { createClient, SupabaseClient, User, Session } from '@supabase/supabase-js';

// Helper to sanitize Supabase URL to the root project URL (stripping /rest/v1, /auth/v1, trailing slashes)
export function normalizeSupabaseUrl(url: string): string {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1\/?$/, '');
}

/**
 * Rejects Supabase secret / service_role keys in frontend code without logging the key value.
 * Blocks both new-format `sb_secret_` keys and legacy JWTs with `role === 'service_role'`.
 */
function isForbiddenSecretKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith('sb_secret_')) {
    return true;
  }

  const parts = trimmed.split('.');
  if (parts.length === 3 && typeof atob === 'function') {
    try {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
      const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
      if (payload && payload.role === 'service_role') {
        return true;
      }
    } catch {
      // Ignore malformed JWT payloads without exposing key material
    }
  }

  return false;
}

/**
 * Returns true if a secret or service_role key was mistakenly provided in client env vars.
 */
export function hasForbiddenSecretKey(): boolean {
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (typeof publishableKey === 'string' && isForbiddenSecretKey(publishableKey)) {
    return true;
  }

  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (typeof anonKey === 'string' && isForbiddenSecretKey(anonKey)) {
    return true;
  }

  return false;
}

/**
 * Resolves the active Supabase public client API key:
 * 1. Preferred: VITE_SUPABASE_PUBLISHABLE_KEY
 * 2. Fallback:  VITE_SUPABASE_ANON_KEY
 * Explicitly rejects sb_secret_ and service_role keys.
 */
export function getActiveSupabaseKey(): string {
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (publishableKey && typeof publishableKey === 'string') {
    const trimmed = publishableKey.trim();
    if (trimmed !== '' && !isForbiddenSecretKey(trimmed)) {
      return trimmed;
    }
  }

  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (anonKey && typeof anonKey === 'string') {
    const trimmed = anonKey.trim();
    if (trimmed !== '' && !isForbiddenSecretKey(trimmed)) {
      return trimmed;
    }
  }

  return '';
}

// Read Vite client-side environment variables
const rawSupabaseUrl: string = import.meta.env.VITE_SUPABASE_URL || '';
export const supabaseUrl: string = normalizeSupabaseUrl(rawSupabaseUrl);
const supabaseKey: string = getActiveSupabaseKey();

/**
 * Checks if real, safe Supabase client credentials have been provided.
 * Verifies both VITE_SUPABASE_PUBLISHABLE_KEY (preferred) and VITE_SUPABASE_ANON_KEY (fallback).
 */
export function isSupabaseConfigured(): boolean {
  const key = getActiveSupabaseKey();
  const url = supabaseUrl;

  return Boolean(
    url &&
    key &&
    !hasForbiddenSecretKey() &&
    !isForbiddenSecretKey(key) &&
    !url.includes('your-project-id') &&
    !key.includes('your-') &&
    !key.includes('your_') &&
    !key.includes('placeholder') &&
    url.startsWith('https://')
  );
}

// Reusable Supabase client instance using the verified active key
export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export interface SupabaseVerificationResult {
  success: boolean;
  configured: boolean;
  message: string;
  projectUrl?: string;
  timestamp: string;
}

/**
 * Verifies that the Supabase client initializes and can communicate with your project
 */
export async function verifySupabaseConnection(): Promise<SupabaseVerificationResult> {
  const timestamp = new Date().toLocaleTimeString();

  if (hasForbiddenSecretKey()) {
    return {
      success: false,
      configured: false,
      timestamp,
      message: 'Secret or service_role keys are blocked in the browser. Use your public VITE_SUPABASE_PUBLISHABLE_KEY instead.',
    };
  }

  if (!isSupabaseConfigured()) {
    return {
      success: false,
      configured: false,
      timestamp,
      message: 'Supabase credentials are not set yet. Please enter VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.',
    };
  }

  if (!supabase) {
    return {
      success: false,
      configured: true,
      timestamp,
      message: 'Supabase client failed to initialize with provided credentials.',
    };
  }

  try {
    // Perform a lightweight session inquiry to verify connection to auth service
    const { error } = await supabase.auth.getSession();
    if (error) {
      return {
        success: false,
        configured: true,
        projectUrl: supabaseUrl,
        timestamp,
        message: `Supabase responded with an issue: ${error.message}`,
      };
    }

    return {
      success: true,
      configured: true,
      projectUrl: supabaseUrl,
      timestamp,
      message: 'Supabase client initialized successfully! Connected to Project URL.',
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      configured: true,
      projectUrl: supabaseUrl,
      timestamp,
      message: `Connection test encountered an error: ${errorMsg}`,
    };
  }
}


/**
 * Constructs a fully qualified, valid absolute redirect URL based on window.location.origin
 * Ensures standard URL protocol, hostname, and an absolute pathname ('/') without illegal fragments.
 */
export function getAuthRedirectUrl(subpath = '/'): string {
  try {
    if (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null') {
      const cleanPath = subpath.startsWith('/') ? subpath : `/${subpath}`;
      const url = new URL(cleanPath, window.location.origin);
      return url.toString();
    }
  } catch {
    // Fall back to configured app URL below
  }

  // Fallback to APP_URL from Vite environment if window.location.origin is unavailable
  const fallback = (import.meta.env.VITE_APP_URL || import.meta.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const cleanPath = subpath.startsWith('/') ? subpath : `/${subpath}`;
  try {
    return new URL(cleanPath, fallback).toString();
  } catch {
    return `${fallback}${cleanPath}`;
  }
}

/**
 * Sign up a new user with email, password, and full name
 */
export async function signUpWithEmail(email: string, password: string, fullName: string) {
  if (!supabase) {
    throw new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  const redirectUrl = getAuthRedirectUrl('/');

  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: {
        full_name: fullName.trim(),
      },
      emailRedirectTo: redirectUrl,
    },
  });

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Sign in an existing user with email and password
 */
export async function signInWithEmail(email: string, password: string) {
  if (!supabase) {
    throw new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Request password reset email
 */
export async function requestPasswordReset(email: string) {
  if (!supabase) {
    throw new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  // Do not include hash fragments like /#reset-password in the redirect URL;
  // Supabase appends the recovery hash tokens directly to the base redirect URL.
  const redirectUrl = getAuthRedirectUrl('/');

  const { data, error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: redirectUrl,
  });

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Verify a recovery token_hash from custom email templates (e.g. ?token_hash=...&type=recovery)
 */
export async function verifyRecoveryTokenHash(tokenHash: string) {
  if (!supabase) {
    throw new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'recovery',
  });

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Update user password after recovery link click
 */
export async function updateUserPassword(newPassword: string) {
  if (!supabase) {
    throw new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  const { data, error } = await supabase.auth.updateUser({
    password: newPassword,
  });

  if (error) throw error;
  return data;
}

export const MAX_DISPLAY_NAME_LENGTH = 50;

/**
 * Update the currently authenticated user's display name in Supabase Auth user metadata.
 * Enforces an active session so a user can only update their own display name.
 */
export async function updateUserDisplayName(displayName: string): Promise<User> {
  if (!supabase) {
    throw new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  const trimmed = displayName.trim();
  if (!trimmed) {
    throw new Error('Please enter a display name.');
  }
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
  }

  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    throw sessionError;
  }
  if (!session?.user?.id) {
    throw new Error('Your session has expired. Please sign in again.');
  }

  const { data, error } = await supabase.auth.updateUser({
    data: {
      display_name: trimmed,
    },
  });

  if (error) {
    throw error;
  }

  if (!data.user) {
    throw new Error('Unable to update display name. Please try again.');
  }

  return data.user;
}

/**
 * Sign out current user
 */
export async function signOutUser() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw error;
  }
}

/**
 * Get current session safely
 */
export async function getSession(): Promise<Session | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

/**
 * Listen to auth state changes (sign-in, sign-out, password recovery, etc.)
 */
export function onAuthStateChange(callback: (event: string, session: Session | null) => void) {
  if (!supabase) return { data: { subscription: { unsubscribe: () => {} } } };
  return supabase.auth.onAuthStateChange(callback);
}

// =========================================================================
// Task Database Operations (public.tasks via Supabase PostgreSQL + RLS)
// =========================================================================

export interface DbTask {
  id: string;
  user_id: string;
  title: string;
  deadline: string | null;
  completed: boolean;
  created_at: string;
}

/**
 * Ensures there is an active authenticated Supabase session and returns the user ID.
 */
async function requireAuthenticatedUserId(): Promise<string> {
  if (!supabase) {
    throw new Error('Supabase is not configured. Please check your environment variables.');
  }

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) {
    throw error;
  }
  if (!session?.user?.id) {
    throw new Error('Your session has expired. Please sign in again.');
  }

  return session.user.id;
}

/**
 * Fetch all tasks belonging to the currently authenticated user.
 * Protected by Supabase Row Level Security (RLS) and filtered by user_id.
 */
export async function fetchUserTasks(): Promise<DbTask[]> {
  const userId = await requireAuthenticatedUserId();

  const { data, error } = await supabase!
    .from('tasks')
    .select('id, user_id, title, deadline, completed, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []) as DbTask[];
}

/**
 * Insert a new task into public.tasks for the currently authenticated user.
 */
export async function createUserTask(title: string, deadline: string | null): Promise<DbTask> {
  const userId = await requireAuthenticatedUserId();

  const { data, error } = await supabase!
    .from('tasks')
    .insert({
      user_id: userId,
      title: title.trim(),
      deadline: deadline && deadline.trim() !== '' ? deadline.trim() : null,
      completed: false,
    })
    .select('id, user_id, title, deadline, completed, created_at')
    .single();

  if (error) {
    throw error;
  }

  return data as DbTask;
}

/**
 * Update a task's completion status in public.tasks for the currently authenticated user.
 */
export async function updateUserTaskCompletion(taskId: string, completed: boolean): Promise<DbTask> {
  const userId = await requireAuthenticatedUserId();

  const { data, error } = await supabase!
    .from('tasks')
    .update({ completed })
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('id, user_id, title, deadline, completed, created_at')
    .single();

  if (error) {
    throw error;
  }

  return data as DbTask;
}

/**
 * Delete a task from public.tasks for the currently authenticated user.
 */
export async function deleteUserTask(taskId: string): Promise<void> {
  const userId = await requireAuthenticatedUserId();

  const { error } = await supabase!
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .eq('user_id', userId);

  if (error) {
    throw error;
  }
}

