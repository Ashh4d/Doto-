/**
 * Doto - Daily Routine & Task Management Dashboard
 * Integrated with Supabase Auth & PostgreSQL (public.tasks) via @supabase/supabase-js.
 */

import { Session, User } from '@supabase/supabase-js';
import {
  DbTask,
  isSupabaseConfigured,
  hasForbiddenSecretKey,
  verifySupabaseConnection,
  supabaseUrl,
  signInWithEmail,
  signUpWithEmail,
  requestPasswordReset,
  verifyRecoveryTokenHash,
  updateUserPassword,
  signOutUser,
  getSession,
  onAuthStateChange,
  fetchUserTasks,
  createUserTask,
  updateUserTaskCompletion,
  deleteUserTask,
} from './supabase';

interface Task {
  id: string;
  user_id: string;
  title: string;
  deadline: string;
  rawDeadline: string | null;
  completed: boolean;
  created_at: string;
  priority: 'High' | 'Medium' | 'Low';
  category: string;
  streak?: number;
}

// Current authenticated user
let currentUser: User | null = null;

// Active tasks state (loaded from Supabase public.tasks)
let tasks: Task[] = [];
let isLoadingTasks = false;
let hasLoadedOnce = false;
let tasksLoadError: string | null = null;
let activeFetchId = 0;
const pendingTaskIds = new Set<string>();

// Current application state
let currentView: 'all' | 'pending' | 'completed' = 'all';
let searchQuery = '';
let activePriorityFilter: 'High' | 'Medium' | 'Low' | null = null;
let toastTimeout: number | null = null;
let selectedDateOffset = 3;

interface AuthUrlErrorInfo {
  message: string;
  isRecoveryOrExpired: boolean;
}

function getHashParamString(): string {
  const rawHash = window.location.hash || '';
  if (!rawHash) return '';
  return rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
}

function extractAuthUrlError(): AuthUrlErrorInfo | null {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const hashStr = getHashParamString();
    const hashParams = hashStr.includes('=') ? new URLSearchParams(hashStr.replace(/^\/+/, '')) : null;

    const error = searchParams.get('error') || hashParams?.get('error') || '';
    const errorCode = searchParams.get('error_code') || hashParams?.get('error_code') || '';
    const errorDescription =
      searchParams.get('error_description') || hashParams?.get('error_description') || '';

    if (!error && !errorCode && !errorDescription) {
      return null;
    }

    const lowerDesc = errorDescription.toLowerCase();
    const isExpiredOrInvalid =
      errorCode === 'otp_expired' ||
      lowerDesc.includes('expired') ||
      lowerDesc.includes('invalid');

    if (isExpiredOrInvalid) {
      return {
        message: 'This password recovery link is invalid or has expired. Please request a new reset link.',
        isRecoveryOrExpired: true,
      };
    }

    return {
      message: errorDescription || 'The authentication link could not be verified. Please try again.',
      isRecoveryOrExpired: errorCode === 'access_denied' || error === 'access_denied',
    };
  } catch {
    return null;
  }
}

function hasRecoveryUrlSignal(): boolean {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('type') === 'recovery') {
      return true;
    }

    const hashStr = getHashParamString();
    if (!hashStr) return false;

    if (hashStr === 'reset-password' || hashStr.startsWith('reset-password?')) {
      return true;
    }

    if (hashStr.includes('=')) {
      const hashParams = new URLSearchParams(hashStr.replace(/^\/+/, ''));
      if (hashParams.get('type') === 'recovery') {
        return true;
      }
    }

    return hashStr.includes('type=recovery');
  } catch {
    return false;
  }
}

function extractRecoveryTokenHash(): string | null {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('type') === 'recovery' && searchParams.get('token_hash')) {
      return searchParams.get('token_hash');
    }

    const hashStr = getHashParamString();
    if (hashStr && hashStr.includes('=')) {
      const hashParams = new URLSearchParams(hashStr.replace(/^\/+/, ''));
      if (hashParams.get('type') === 'recovery' && hashParams.get('token_hash')) {
        return hashParams.get('token_hash');
      }
    }

    return null;
  } catch {
    return null;
  }
}

function hasUnconsumedImplicitAccessToken(): boolean {
  const hashStr = getHashParamString();
  return /(^|[&#/])(access_token|refresh_token)=/.test(hashStr);
}

function cleanAuthUrlParams(): void {
  try {
    const search = window.location.search || '';
    const hash = window.location.hash || '';
    const hasAuthQuery = /(^|[?&])(code|type|token_hash|error|error_code|error_description)=/.test(search);
    const hasAuthHash = /(access_token|refresh_token|token_hash|type=recovery|error=|error_code=|error_description=|reset-password)/.test(
      hash
    );

    if (hasAuthQuery || hasAuthHash) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  } catch {
    // Ignore history API restrictions
  }
}

// Capture recovery/error URL signals synchronously before Supabase async URL cleanup runs
const initialAuthUrlError = extractAuthUrlError();
const initialRecoveryTokenHash = !initialAuthUrlError ? extractRecoveryTokenHash() : null;
const initialHadImplicitTokens = !initialAuthUrlError && hasUnconsumedImplicitAccessToken();
const initialRecoveryUrlSignal = !initialAuthUrlError && (hasRecoveryUrlSignal() || Boolean(initialRecoveryTokenHash));

let isPasswordRecoveryMode = initialRecoveryUrlSignal;
let pendingAuthUrlError: AuthUrlErrorInfo | null = initialAuthUrlError;
let hasActiveAuthUrlError = Boolean(initialAuthUrlError);
let isAppBootstrapped = false;

// =========================================================================
// DOM Element References
// =========================================================================

// Containers
const authContainer = document.getElementById('auth-container') as HTMLDivElement;
const dashboardContainer = document.getElementById('dashboard-container') as HTMLDivElement;
const supabaseConfigAlert = document.getElementById('supabase-config-alert') as HTMLDivElement;

// Auth Cards
const loginCard = document.getElementById('login-card') as HTMLDivElement;
const signupCard = document.getElementById('signup-card') as HTMLDivElement;
const forgotPasswordCard = document.getElementById('forgot-password-card') as HTMLDivElement;
const verifyEmailCard = document.getElementById('verify-email-card') as HTMLDivElement;
const resetPasswordCard = document.getElementById('reset-password-card') as HTMLDivElement;

// Login Form Elements
const loginForm = document.getElementById('login-form') as HTMLFormElement;
const loginEmail = document.getElementById('login-email') as HTMLInputElement;
const loginPassword = document.getElementById('login-password') as HTMLInputElement;
const loginTogglePwd = document.getElementById('login-toggle-pwd') as HTMLButtonElement;
const loginEyeIcon = document.getElementById('login-eye-icon') as unknown as SVGElement;
const loginSubmitBtn = document.getElementById('login-submit-btn') as HTMLButtonElement;
const loginSubmitText = document.getElementById('login-submit-text') as HTMLElement;
const loginSpinner = document.getElementById('login-spinner') as unknown as SVGElement;
const loginErrorBanner = document.getElementById('login-error-banner') as HTMLDivElement;
const loginErrorText = document.getElementById('login-error-text') as HTMLElement;
const gotoSignupBtn = document.getElementById('goto-signup-btn') as HTMLButtonElement;
const gotoForgotPwd = document.getElementById('goto-forgot-pwd') as HTMLButtonElement;

// Signup Form Elements
const signupForm = document.getElementById('signup-form') as HTMLFormElement;
const signupName = document.getElementById('signup-name') as HTMLInputElement;
const signupEmail = document.getElementById('signup-email') as HTMLInputElement;
const signupPassword = document.getElementById('signup-password') as HTMLInputElement;
const signupConfirmPassword = document.getElementById('signup-confirm-password') as HTMLInputElement;
const signupTogglePwd = document.getElementById('signup-toggle-pwd') as HTMLButtonElement;
const signupEyeIcon = document.getElementById('signup-eye-icon') as unknown as SVGElement;
const signupSubmitBtn = document.getElementById('signup-submit-btn') as HTMLButtonElement;
const signupSubmitText = document.getElementById('signup-submit-text') as HTMLElement;
const signupSpinner = document.getElementById('signup-spinner') as unknown as SVGElement;
const signupErrorBanner = document.getElementById('signup-error-banner') as HTMLDivElement;
const signupErrorText = document.getElementById('signup-error-text') as HTMLElement;
const gotoLoginBtn = document.getElementById('goto-login-btn') as HTMLButtonElement;

// Forgot Password Form Elements
const forgotForm = document.getElementById('forgot-form') as HTMLFormElement;
const forgotEmail = document.getElementById('forgot-email') as HTMLInputElement;
const forgotSubmitBtn = document.getElementById('forgot-submit-btn') as HTMLButtonElement;
const forgotSubmitText = document.getElementById('forgot-submit-text') as HTMLElement;
const forgotSpinner = document.getElementById('forgot-spinner') as unknown as SVGElement;
const forgotMessageBanner = document.getElementById('forgot-message-banner') as HTMLDivElement;
const forgotBackBtn = document.getElementById('forgot-back-btn') as HTMLButtonElement;

// Verify Email Card Elements
const verifyEmailDisplay = document.getElementById('verify-email-display') as HTMLElement;
const verifyBackBtn = document.getElementById('verify-back-btn') as HTMLButtonElement;

// Reset Password Form Elements
const resetPwdForm = document.getElementById('reset-pwd-form') as HTMLFormElement;
const newPasswordInput = document.getElementById('new-password-input') as HTMLInputElement;
const newPasswordConfirm = document.getElementById('new-password-confirm') as HTMLInputElement;
const resetPwdSubmitBtn = document.getElementById('reset-pwd-submit-btn') as HTMLButtonElement;
const resetPwdSubmitText = document.getElementById('reset-pwd-submit-text') as HTMLElement;
const resetPwdSpinner = document.getElementById('reset-pwd-spinner') as unknown as SVGElement;
const resetPwdErrorBanner = document.getElementById('reset-pwd-error-banner') as HTMLDivElement;
const resetPwdErrorText = document.getElementById('reset-pwd-error-text') as HTMLElement;

// User Profile Elements in Dashboard
const userDisplayName = document.getElementById('user-display-name') as HTMLElement;
const userDisplayEmail = document.getElementById('user-display-email') as HTMLElement;
const userAvatarInitials = document.getElementById('user-avatar-initials') as HTMLElement;
const topAvatarInitials = document.getElementById('top-avatar-initials') as HTMLElement;
const sidebarLogoutBtn = document.getElementById('sidebar-logout-btn') as HTMLButtonElement;
const mobileLogoutBtn = document.getElementById('mobile-logout-btn') as HTMLButtonElement;
const greetingHeading = document.getElementById('greeting-heading') as HTMLElement;
const currentDateText = document.getElementById('current-date-text') as HTMLElement;

// Supabase Integration Card Elements
const supabaseStatusCard = document.getElementById('supabase-status-card') as HTMLElement | null;
const supabaseStatusPill = document.getElementById('supabase-status-pill') as HTMLElement | null;
const supabaseStatusDot = document.getElementById('supabase-status-dot') as HTMLElement | null;
const supabaseStatusText = document.getElementById('supabase-status-text') as HTMLElement | null;
const supabaseStatusDesc = document.getElementById('supabase-status-desc') as HTMLElement | null;
const toggleSupabaseGuideBtn = document.getElementById('toggle-supabase-guide-btn') as HTMLButtonElement | null;
const supabaseGuidePanel = document.getElementById('supabase-guide-panel') as HTMLElement | null;
const testSupabaseBtn = document.getElementById('test-supabase-btn') as HTMLButtonElement | null;
const testSupabaseSpinner = document.getElementById('test-supabase-spinner') as unknown as SVGElement | null;
const testSupabaseText = document.getElementById('test-supabase-text') as HTMLElement | null;
const supabaseVerifyResult = document.getElementById('supabase-verify-result') as HTMLElement | null;
const supabaseVerifyTime = document.getElementById('supabase-verify-time') as HTMLElement | null;
const supabaseVerifyMessage = document.getElementById('supabase-verify-message') as HTMLElement | null;
const supabaseVerifyUrl = document.getElementById('supabase-verify-url') as HTMLElement | null;


// Dashboard UI references
const taskListEl = document.getElementById('task-list') as HTMLUListElement;
const tasksLoadingState = document.getElementById('tasks-loading-state') as HTMLDivElement | null;
const tasksSyncIndicator = document.getElementById('tasks-sync-indicator') as HTMLElement | null;
const tasksErrorBanner = document.getElementById('tasks-error-banner') as HTMLDivElement | null;
const tasksErrorText = document.getElementById('tasks-error-text') as HTMLElement | null;
const tasksRetryBtn = document.getElementById('tasks-retry-btn') as HTMLButtonElement | null;
const emptyStateEl = document.getElementById('empty-state') as HTMLDivElement;
const emptyTitleEl = document.getElementById('empty-title') as HTMLElement;
const emptySubtitleEl = document.getElementById('empty-subtitle') as HTMLElement;
const emptyActionBtn = document.getElementById('empty-action-btn') as HTMLButtonElement;
const emptyActionText = document.getElementById('empty-action-text') as HTMLElement;

const searchInput = document.getElementById('search-input') as HTMLInputElement;
const mobileSearchInput = document.getElementById('mobile-search-input') as HTMLInputElement;
const searchClearBtn = document.getElementById('search-clear-btn') as HTMLButtonElement;
const weekStripEl = document.getElementById('week-strip') as HTMLElement;

// Overview counts
const overviewTotalEl = document.getElementById('overview-total-count') as HTMLElement;
const overviewCompletedEl = document.getElementById('overview-completed-count') as HTMLElement;
const overviewPendingEl = document.getElementById('overview-pending-count') as HTMLElement;
const completionPercentageEl = document.getElementById('completion-percentage') as HTMLElement;

// Navigation buttons
const navAll = document.getElementById('nav-all') as HTMLButtonElement;
const navPending = document.getElementById('nav-pending') as HTMLButtonElement;
const navCompleted = document.getElementById('nav-completed') as HTMLButtonElement;
const navAllCount = document.getElementById('nav-all-count') as HTMLElement;
const navPendingCount = document.getElementById('nav-pending-count') as HTMLElement;
const navCompletedCount = document.getElementById('nav-completed-count') as HTMLElement;

// Priority filter elements
const priorityHighBtn = document.getElementById('priority-filter-high') as HTMLButtonElement;
const priorityMediumBtn = document.getElementById('priority-filter-medium') as HTMLButtonElement;
const priorityLowBtn = document.getElementById('priority-filter-low') as HTMLButtonElement;
const priorityHighCount = document.getElementById('priority-high-count') as HTMLElement;
const priorityMediumCount = document.getElementById('priority-medium-count') as HTMLElement;
const priorityLowCount = document.getElementById('priority-low-count') as HTMLElement;
const priorityClearBtn = document.getElementById('priority-clear-btn') as HTMLButtonElement;

const taskBadgeCount = document.getElementById('task-badge-count') as HTMLElement;
const activeFilterIndicator = document.getElementById('active-filter-indicator') as HTMLElement;
const activeFilterText = document.getElementById('active-filter-text') as HTMLElement;
const clearFilterBtn = document.getElementById('clear-filter-btn') as HTMLButtonElement;
const filterTabs = document.querySelectorAll<HTMLButtonElement>('.filter-tab');

// Modal Elements
const addTaskModal = document.getElementById('add-task-modal') as HTMLDivElement;
const addTaskForm = document.getElementById('add-task-form') as HTMLFormElement;
const modalErrorBanner = document.getElementById('modal-error-banner') as HTMLDivElement | null;
const modalErrorText = document.getElementById('modal-error-text') as HTMLElement | null;
const taskTitleInput = document.getElementById('task-title-input') as HTMLInputElement;
const taskTitleError = document.getElementById('task-title-error') as HTMLElement;
const taskDeadlineInput = document.getElementById('task-deadline-input') as HTMLInputElement;
const createTaskBtn = document.getElementById('create-task-btn') as HTMLButtonElement | null;
const createTaskSpinner = document.getElementById('create-task-spinner') as unknown as SVGElement | null;
const createTaskText = document.getElementById('create-task-text') as HTMLElement | null;
const openAddTaskBtn = document.getElementById('banner-add-btn') as HTMLButtonElement;
const fabAddTaskBtn = document.getElementById('fab-add-task-btn') as HTMLButtonElement;
const mobileAddBtn = document.getElementById('mobile-add-btn') as HTMLButtonElement;
const closeModalBtn = document.getElementById('close-modal-btn') as HTMLButtonElement;
const cancelModalBtn = document.getElementById('cancel-modal-btn') as HTMLButtonElement;

// Toast Elements
const toastEl = document.getElementById('toast-notification') as HTMLDivElement;
const toastMessageEl = document.getElementById('toast-message') as HTMLElement;
const toastCloseBtn = document.getElementById('toast-close-btn') as HTMLButtonElement;

// Mobile Drawer Elements
const mobileMenuBtn = document.getElementById('mobile-menu-btn') as HTMLButtonElement;
const mobileDrawerClose = document.getElementById('mobile-drawer-close') as HTMLButtonElement;
const mobileDrawerBackdrop = document.getElementById('mobile-drawer-backdrop') as HTMLDivElement;
const sidebar = document.getElementById('sidebar') as HTMLElement;

// =========================================================================
// UI Helpers & Navigation
// =========================================================================

/**
 * Show a specific auth card
 */
function showAuthCard(card: 'login' | 'signup' | 'forgot' | 'verify' | 'reset') {
  if (loginCard) loginCard.classList.toggle('hidden', card !== 'login');
  if (signupCard) signupCard.classList.toggle('hidden', card !== 'signup');
  if (forgotPasswordCard) forgotPasswordCard.classList.toggle('hidden', card !== 'forgot');
  if (verifyEmailCard) verifyEmailCard.classList.toggle('hidden', card !== 'verify');
  if (resetPasswordCard) resetPasswordCard.classList.toggle('hidden', card !== 'reset');

  // Clear any errors
  if (loginErrorBanner) loginErrorBanner.classList.add('hidden');
  if (signupErrorBanner) signupErrorBanner.classList.add('hidden');
  if (forgotMessageBanner) forgotMessageBanner.classList.add('hidden');
  if (resetPwdErrorBanner) resetPwdErrorBanner.classList.add('hidden');
}

/**
 * Update user display in dashboard
 */
function updateUserProfileUI(user: User | null) {
  if (!user) return;

  const fullName = (user.user_metadata?.full_name as string) || '';
  const email = user.email || 'user@example.com';
  const displayName = fullName || email.split('@')[0] || 'User';

  if (userDisplayName) userDisplayName.textContent = displayName;
  if (userDisplayEmail) userDisplayEmail.textContent = email;

  // Calculate initials (e.g., Alex Rivera -> AR)
  const initials = fullName
    ? fullName
        .split(' ')
        .map((p) => p[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : displayName.slice(0, 2).toUpperCase();

  if (userAvatarInitials) userAvatarInitials.textContent = initials;
  if (topAvatarInitials) topAvatarInitials.textContent = initials;

  // Header dynamic greeting
  const now = new Date();
  const hours = now.getHours();
  let timeGreeting = 'Morning';
  if (hours >= 12 && hours < 17) timeGreeting = 'Afternoon';
  else if (hours >= 17) timeGreeting = 'Evening';

  if (greetingHeading) {
    greetingHeading.textContent = `${timeGreeting}, ${displayName}`;
  }
}

/**
 * Format database errors into clear, actionable messages
 */
function formatDatabaseError(error: unknown): string {
  if (!error) return 'An unexpected database error occurred.';

  let msg = '';
  let code = '';
  if (typeof error === 'string') {
    msg = error;
  } else if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, any>;
    msg = err.message || err.error_description || err.details || err.hint || '';
    code = err.code || '';
  }

  if (code === '42501' || msg.toLowerCase().includes('row-level security')) {
    return 'Permission denied by database security policy. Please ensure you are signed in.';
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    return 'Unable to reach Supabase database. Please check your connection and try again.';
  }
  if (msg.toLowerCase().includes('jwt') || msg.toLowerCase().includes('session')) {
    return 'Your session has expired. Please sign in again.';
  }

  return msg || String(error);
}

/**
 * Map a row from public.tasks to UI Task shape
 */
function mapDbTaskToTask(dbTask: DbTask): Task {
  return {
    id: dbTask.id,
    user_id: dbTask.user_id,
    title: dbTask.title,
    deadline: dbTask.deadline ? formatDeadline(dbTask.deadline) : 'No deadline',
    rawDeadline: dbTask.deadline,
    completed: Boolean(dbTask.completed),
    created_at: dbTask.created_at,
    priority: 'Medium',
    category: 'Routine',
    streak: 1,
  };
}

/**
 * Update loading and error indicators for task list
 */
function updateTaskStatusUI(): void {
  const showInitialLoader = isLoadingTasks && !hasLoadedOnce && tasks.length === 0;

  if (tasksLoadingState) {
    tasksLoadingState.classList.toggle('hidden', !showInitialLoader);
  }
  if (tasksSyncIndicator) {
    tasksSyncIndicator.classList.toggle('hidden', !(isLoadingTasks && !showInitialLoader));
  }
  if (tasksErrorBanner && tasksErrorText) {
    if (tasksLoadError) {
      tasksErrorText.textContent = tasksLoadError;
      tasksErrorBanner.classList.remove('hidden');
    } else {
      tasksErrorBanner.classList.add('hidden');
    }
  }
}

/**
 * Fetch tasks for the currently authenticated user from Supabase PostgreSQL
 */
async function loadTasksFromSupabase(): Promise<void> {
  if (!currentUser) {
    tasks = [];
    hasLoadedOnce = false;
    isLoadingTasks = false;
    tasksLoadError = null;
    updateTaskStatusUI();
    updateCounts();
    renderTasks();
    return;
  }

  const fetchId = ++activeFetchId;
  isLoadingTasks = true;
  tasksLoadError = null;
  updateTaskStatusUI();
  if (!hasLoadedOnce && tasks.length === 0) {
    if (emptyStateEl) emptyStateEl.classList.add('hidden');
    if (taskListEl) taskListEl.innerHTML = '';
  }

  try {
    const dbTasks = await fetchUserTasks();
    if (fetchId !== activeFetchId || !currentUser) return;

    tasks = dbTasks.map(mapDbTaskToTask);
    hasLoadedOnce = true;
    tasksLoadError = null;
  } catch (err: unknown) {
    if (fetchId !== activeFetchId) return;
    tasksLoadError = formatDatabaseError(err);
  } finally {
    if (fetchId === activeFetchId) {
      isLoadingTasks = false;
      updateTaskStatusUI();
      updateCounts();
      renderTasks();
    }
  }
}

function showInvalidRecoveryLinkError(): void {
  if (!resetPwdErrorBanner || !resetPwdErrorText) return;

  const requestBtn = document.createElement('button');
  requestBtn.type = 'button';
  requestBtn.className = 'underline font-bold text-red-800 hover:text-red-950 cursor-pointer ml-1';
  requestBtn.textContent = 'Request a new reset link';
  requestBtn.onclick = () => {
    isPasswordRecoveryMode = false;
    cleanAuthUrlParams();
    showAuthCard('forgot');
  };

  resetPwdErrorText.replaceChildren(
    document.createTextNode('This password recovery link is invalid or has expired.'),
    requestBtn
  );
  resetPwdErrorBanner.classList.remove('hidden');
}

function displayAuthUrlErrorBanner(errorInfo: AuthUrlErrorInfo): void {
  isPasswordRecoveryMode = false;
  setAuthState(null);

  if (errorInfo.isRecoveryOrExpired && forgotMessageBanner) {
    showAuthCard('forgot');
    forgotMessageBanner.className =
      'mb-4 p-3 text-xs rounded-2xl flex items-start gap-2 bg-red-50 border border-red-200 text-red-700';
    const msgSpan = document.createElement('span');
    msgSpan.textContent = errorInfo.message;
    forgotMessageBanner.replaceChildren(msgSpan);
    forgotMessageBanner.classList.remove('hidden');
    return;
  }

  showAuthCard('login');
  if (loginErrorBanner && loginErrorText) {
    loginErrorText.textContent = errorInfo.message;
    loginErrorBanner.classList.remove('hidden');
  }
}

/**
 * Enforces Password Recovery Mode:
 * Keeps dashboard hidden, shows auth container, and displays the reset-password card.
 */
function enterPasswordRecoveryMode(): void {
  isPasswordRecoveryMode = true;

  // Cancel any in-flight dashboard data fetches and reset task UI state
  activeFetchId++;
  tasks = [];
  hasLoadedOnce = false;
  isLoadingTasks = false;
  tasksLoadError = null;
  pendingTaskIds.clear();
  updateTaskStatusUI();
  updateCounts();
  renderTasks();

  if (addTaskModal && !addTaskModal.classList.contains('hidden')) {
    closeModal();
  }
  closeMobileDrawer();

  if (dashboardContainer) dashboardContainer.classList.add('hidden');
  if (authContainer) authContainer.classList.remove('hidden');

  if (supabaseConfigAlert) {
    supabaseConfigAlert.classList.toggle('hidden', isSupabaseConfigured());
  }

  // Only switch cards when reset card isn't already visible so active error banners stay intact
  if (resetPasswordCard && resetPasswordCard.classList.contains('hidden')) {
    showAuthCard('reset');
  } else {
    if (loginCard) loginCard.classList.add('hidden');
    if (signupCard) signupCard.classList.add('hidden');
    if (forgotPasswordCard) forgotPasswordCard.classList.add('hidden');
    if (verifyEmailCard) verifyEmailCard.classList.add('hidden');
    if (resetPasswordCard) resetPasswordCard.classList.remove('hidden');
  }
}

/**
 * Switch between Auth View and Protected Dashboard View
 * Protects dashboard so unauthenticated users and active recovery flows cannot access it
 */
function setAuthState(user: User | null) {
  if (isPasswordRecoveryMode) {
    currentUser = user ?? currentUser;
    enterPasswordRecoveryMode();
    return;
  }

  const previousUserId = currentUser?.id ?? null;
  currentUser = user;

  if (user) {
    // Authenticated user session
    if (authContainer) authContainer.classList.add('hidden');
    if (dashboardContainer) dashboardContainer.classList.remove('hidden');

    updateUserProfileUI(user);

    if (user.id !== previousUserId || !hasLoadedOnce) {
      tasks = [];
      hasLoadedOnce = false;
      tasksLoadError = null;
      pendingTaskIds.clear();
      updateCounts();
      void loadTasksFromSupabase();
    }
  } else {
    // Unauthenticated: Strictly protect Doto dashboard
    activeFetchId++;
    tasks = [];
    hasLoadedOnce = false;
    isLoadingTasks = false;
    tasksLoadError = null;
    pendingTaskIds.clear();
    updateTaskStatusUI();
    updateCounts();
    renderTasks();

    if (dashboardContainer) dashboardContainer.classList.add('hidden');
    if (authContainer) authContainer.classList.remove('hidden');

    // Check if Supabase credentials need to be configured
    if (supabaseConfigAlert) {
      if (!isSupabaseConfigured()) {
        supabaseConfigAlert.classList.remove('hidden');
      } else {
        supabaseConfigAlert.classList.add('hidden');
      }
    }

    showAuthCard('login');
  }
}

/**
 * Initializes and manages the Supabase integration status widget in development mode only.
 */
async function initSupabaseStatusWidget() {
  if (!import.meta.env.DEV) {
    if (supabaseStatusCard) {
      supabaseStatusCard.classList.add('hidden');
    }
    return;
  }

  if (supabaseStatusCard) {
    supabaseStatusCard.classList.remove('hidden');
  }

  const configured = isSupabaseConfigured();

  // Set initial status badge appearance based on credential presence
  if (configured) {
    if (supabaseStatusPill) {
      supabaseStatusPill.className =
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
    }
    if (supabaseStatusDot) {
      supabaseStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
    }
    if (supabaseStatusText) {
      supabaseStatusText.textContent = 'Configured & Ready';
    }
    if (supabaseStatusDesc) {
      const urlSpan = document.createElement('span');
      urlSpan.className = 'font-mono text-stone-800 font-semibold';
      urlSpan.textContent = supabaseUrl;
      supabaseStatusDesc.replaceChildren(
        document.createTextNode('Supabase client ready with Project URL: '),
        urlSpan,
        document.createTextNode('. Click Verify Client to test connection.')
      );
    }
  } else {
    if (supabaseStatusPill) {
      supabaseStatusPill.className =
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200';
    }
    if (supabaseStatusDot) {
      supabaseStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse';
    }
    if (supabaseStatusText) {
      supabaseStatusText.textContent = hasForbiddenSecretKey() ? 'Blocked Secret Key' : 'Awaiting Credentials';
    }
    if (supabaseStatusDesc) {
      if (hasForbiddenSecretKey()) {
        supabaseStatusDesc.textContent =
          'Secret or service_role keys cannot be used in the browser. Set VITE_SUPABASE_PUBLISHABLE_KEY instead.';
      } else {
        const sdkSpan = document.createElement('span');
        sdkSpan.className = 'font-mono text-stone-700 font-medium';
        sdkSpan.textContent = '@supabase/supabase-js';
        supabaseStatusDesc.replaceChildren(
          document.createTextNode('Client configured with '),
          sdkSpan,
          document.createTextNode('. Enter your Project URL & Publishable Key to connect.')
        );
      }
    }
  }

  // Toggle credential location guide accordion
  if (toggleSupabaseGuideBtn && supabaseGuidePanel) {
    toggleSupabaseGuideBtn.onclick = () => {
      const isHidden = supabaseGuidePanel.classList.toggle('hidden');
      toggleSupabaseGuideBtn.textContent = isHidden ? 'Credential Guide' : 'Hide Guide';
    };
  }

  // Verify client button handler
  if (testSupabaseBtn) {
    testSupabaseBtn.onclick = async () => {
      if (testSupabaseSpinner) testSupabaseSpinner.classList.remove('hidden');
      if (testSupabaseText) testSupabaseText.textContent = 'Verifying...';
      testSupabaseBtn.disabled = true;

      try {
        const result = await verifySupabaseConnection();

        if (supabaseVerifyResult) supabaseVerifyResult.classList.remove('hidden');
        if (supabaseVerifyTime) supabaseVerifyTime.textContent = result.timestamp;
        if (supabaseVerifyMessage) {
          supabaseVerifyMessage.textContent = result.message;
          supabaseVerifyMessage.className = result.success
            ? 'font-sans text-xs font-bold text-emerald-800'
            : result.configured
            ? 'font-sans text-xs font-bold text-amber-800'
            : 'font-sans text-xs font-bold text-red-700';
        }
        if (supabaseVerifyUrl) {
          supabaseVerifyUrl.textContent = result.projectUrl
            ? `Target Project: ${result.projectUrl}`
            : 'Target: No Project URL detected in environment variables yet.';
        }

        // Dynamically update status badge
        if (result.success) {
          if (supabaseStatusPill) {
            supabaseStatusPill.className =
              'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
          }
          if (supabaseStatusDot) {
            supabaseStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
          }
          if (supabaseStatusText) {
            supabaseStatusText.textContent = 'Connected & Verified';
          }
        }
      } catch (err: unknown) {
        if (supabaseVerifyResult) supabaseVerifyResult.classList.remove('hidden');
        if (supabaseVerifyMessage) {
          supabaseVerifyMessage.textContent = `Verification error: ${err instanceof Error ? err.message : String(err)}`;
          supabaseVerifyMessage.className = 'font-sans text-xs font-bold text-red-700';
        }
      } finally {
        if (testSupabaseSpinner) testSupabaseSpinner.classList.add('hidden');
        if (testSupabaseText) testSupabaseText.textContent = 'Verify Client';
        testSupabaseBtn.disabled = false;
      }
    };
  }
}


/**
 * Format auth errors into clear, friendly human language,
 * while always surfacing the actual Supabase error message when unmapped.
 */
function formatAuthError(error: unknown): string {
  if (!error) return 'An unexpected authentication error occurred.';

  let msg = '';
  if (typeof error === 'string') {
    msg = error;
  } else if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, any>;
    msg = err.message || err.error_description || err.msg || err.error || '';
  }

  if (msg.includes('Invalid login credentials')) {
    return 'Incorrect email or password. Please verify your credentials and try again.';
  }
  if (msg.includes('Email not confirmed')) {
    return 'Your email has not been verified yet. Please check your inbox for the confirmation link before signing in.';
  }
  if (msg.includes('User already registered') || msg.includes('already exists')) {
    return 'An account with this email address already exists. Please sign in instead.';
  }
  if (msg.includes('Password should be at least') || msg.includes('weak_password') || msg.includes('Password is too short')) {
    return 'Password is too weak. Please use at least 6 characters.';
  }
  if (msg.includes('Invalid email') || msg.includes('valid email')) {
    return 'Please enter a valid email address.';
  }
  if (msg.includes('rate limit') || msg.includes('over_email_send_rate_limit')) {
    return 'Too many requests sent. Please wait a moment before trying again.';
  }
  if (msg.includes('Signups not allowed') || msg.includes('signup_disabled')) {
    return 'Signups are currently disabled in your Supabase project settings.';
  }
  if (msg.includes('NetworkError') || msg.includes('Failed to fetch')) {
    return 'Unable to connect to Supabase. Please verify your VITE_SUPABASE_URL and internet connection.';
  }

  // Always show the actual Supabase error string if not specifically mapped
  return msg || String(error);
}

/**
 * Toggle password field visibility
 */
function setupPasswordToggle(input: HTMLInputElement, toggleBtn: HTMLButtonElement, eyeSvg: SVGElement) {
  toggleBtn.onclick = () => {
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';

    if (isPassword) {
      // Eye crossed out icon
      eyeSvg.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/>`;
    } else {
      // Open eye icon
      eyeSvg.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>`;
    }
  };
}

// =========================================================================
// Dashboard Helper Methods
// =========================================================================

/**
 * Setup header date
 */
function setupHeaderDate(): void {
  const now = new Date();
  if (currentDateText) {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    };
    currentDateText.textContent = now.toLocaleDateString('en-US', options);
  }
}

/**
 * Render the 7-day week calendar strip (Mon - Sun)
 */
function renderWeekStrip(): void {
  if (!weekStripEl) return;
  weekStripEl.innerHTML = '';

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = new Date();
  const currentDayOfWeek = (today.getDay() + 6) % 7;

  const monday = new Date(today);
  monday.setDate(today.getDate() - currentDayOfWeek);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(monday);
    dayDate.setDate(monday.getDate() + i);
    const dayNum = dayDate.getDate();
    const isSelected = i === selectedDateOffset;

    const col = document.createElement('div');
    col.className = 'flex flex-col items-center gap-1.5 cursor-pointer group';

    col.innerHTML = `
      <span class="text-[11px] font-semibold ${isSelected ? 'text-[#1E1A17] font-bold' : 'text-stone-400 group-hover:text-stone-600'}">
        ${dayNames[i]}
      </span>
      <button 
        type="button" 
        class="w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-xs sm:text-sm transition-all duration-150 cursor-pointer ${
          isSelected
            ? 'bg-[#2A1E17] text-white font-bold shadow-sm scale-105'
            : 'text-[#1E1A17] font-semibold hover:bg-[#F2ECE3]'
        }"
      >
        ${dayNum}
      </button>
    `;

    col.onclick = () => {
      selectedDateOffset = i;
      renderWeekStrip();
    };

    weekStripEl.appendChild(col);
  }
}

/**
 * Format deadline date from date picker input or PostgreSQL date column
 */
function formatDeadline(dateStr: string | null): string {
  if (!dateStr) {
    return 'No deadline';
  }

  const datePart = dateStr.split('T')[0];
  const parts = datePart.split('-');
  if (parts.length !== 3) return dateStr;

  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  const targetDate = new Date(y, m, d);

  if (Number.isNaN(targetDate.getTime())) {
    return dateStr;
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (targetDate.getTime() === today.getTime()) {
    return 'Today';
  } else if (targetDate.getTime() === tomorrow.getTime()) {
    return 'Tomorrow';
  } else {
    return targetDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  }
}

/**
 * Helper to get pastel icon styling based on category or task name
 */
function getCategoryIcon(category: string, title: string): { bg: string; text: string; icon: string } {
  const t = (title + ' ' + category).toLowerCase();

  if (t.includes('water') || t.includes('drink') || t.includes('glass')) {
    return {
      bg: 'bg-[#FFEFE6]',
      text: 'text-[#E26D46]',
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>`,
    };
  }
  if (t.includes('meditate') || t.includes('relax') || t.includes('breathe')) {
    return {
      bg: 'bg-[#EAF6EC]',
      text: 'text-[#2E7D32]',
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    };
  }
  if (t.includes('stretch') || t.includes('fitness') || t.includes('exercise')) {
    return {
      bg: 'bg-[#F6EDFF]',
      text: 'text-[#7C3AED]',
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    };
  }
  if (t.includes('walk') || t.includes('run') || t.includes('outdoor')) {
    return {
      bg: 'bg-[#FDF0E6]',
      text: 'text-[#D97706]',
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064"/></svg>`,
    };
  }
  if (t.includes('roadmap') || t.includes('product') || t.includes('presentation')) {
    return {
      bg: 'bg-[#FEF6E7]',
      text: 'text-[#B45309]',
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>`,
    };
  }

  return {
    bg: 'bg-[#EEF5FF]',
    text: 'text-[#2563EB]',
    icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>`,
  };
}

/**
 * Toast notification
 */
function showToast(message = 'Task created successfully!') {
  if (!toastEl) return;

  if (toastMessageEl) {
    toastMessageEl.textContent = message;
  }

  if (toastTimeout !== null) {
    window.clearTimeout(toastTimeout);
  }

  toastEl.classList.remove('translate-y-12', 'opacity-0', 'pointer-events-none');
  toastEl.classList.add('translate-y-0', 'opacity-100', 'pointer-events-auto');

  toastTimeout = window.setTimeout(() => {
    hideToast();
  }, 3000);
}

function hideToast() {
  if (!toastEl) return;
  toastEl.classList.remove('translate-y-0', 'opacity-100', 'pointer-events-auto');
  toastEl.classList.add('translate-y-12', 'opacity-0', 'pointer-events-none');
  if (toastTimeout !== null) {
    window.clearTimeout(toastTimeout);
    toastTimeout = null;
  }
}

/**
 * Update overview statistics and badges
 */
function updateCounts() {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.completed).length;
  const pending = total - completed;
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);

  if (overviewTotalEl) overviewTotalEl.textContent = total.toString();
  if (overviewCompletedEl) overviewCompletedEl.textContent = completed.toString();
  if (overviewPendingEl) overviewPendingEl.textContent = pending.toString();
  if (completionPercentageEl) completionPercentageEl.textContent = `${percentage}%`;

  if (navAllCount) navAllCount.textContent = total.toString();
  if (navPendingCount) navPendingCount.textContent = pending.toString();
  if (navCompletedCount) navCompletedCount.textContent = completed.toString();

  // Dynamic priority counts
  const highCount = tasks.filter((t) => t.priority === 'High').length;
  const mediumCount = tasks.filter((t) => t.priority === 'Medium').length;
  const lowCount = tasks.filter((t) => t.priority === 'Low').length;

  if (priorityHighCount) priorityHighCount.textContent = highCount.toString();
  if (priorityMediumCount) priorityMediumCount.textContent = mediumCount.toString();
  if (priorityLowCount) priorityLowCount.textContent = lowCount.toString();

  updatePriorityFilterUI();
}

function updatePriorityFilterUI() {
  const priorityBtns = [
    { btn: priorityHighBtn, p: 'High' },
    { btn: priorityMediumBtn, p: 'Medium' },
    { btn: priorityLowBtn, p: 'Low' },
  ];

  priorityBtns.forEach(({ btn, p }) => {
    if (!btn) return;
    if (activePriorityFilter === p) {
      btn.className =
        'priority-btn w-full flex items-center justify-between px-3.5 py-1.5 text-xs font-bold rounded-xl transition-colors cursor-pointer bg-[#FFF3E8] text-[#9A3816]';
    } else {
      btn.className =
        'priority-btn w-full flex items-center justify-between px-3.5 py-1.5 text-xs text-stone-600 hover:text-stone-900 hover:bg-[#F2ECE3] rounded-xl transition-colors cursor-pointer';
    }
  });

  if (priorityClearBtn) {
    if (activePriorityFilter !== null) {
      priorityClearBtn.classList.remove('hidden');
    } else {
      priorityClearBtn.classList.add('hidden');
    }
  }

  if (activeFilterIndicator && activeFilterText) {
    if (activePriorityFilter !== null) {
      activeFilterIndicator.classList.remove('hidden');
      activeFilterIndicator.classList.add('inline-flex');
      activeFilterText.textContent = `${activePriorityFilter} Priority`;
    } else {
      activeFilterIndicator.classList.add('hidden');
      activeFilterIndicator.classList.remove('inline-flex');
    }
  }
}

/**
 * Render the filtered task list
 */
function renderTasks() {
  updateTaskStatusUI();

  if (isLoadingTasks && !hasLoadedOnce && tasks.length === 0) {
    taskListEl.innerHTML = '';
    emptyStateEl.classList.add('hidden');
    if (taskBadgeCount) taskBadgeCount.textContent = '0';
    return;
  }

  let filtered = tasks.filter((task) => {
    if (currentView === 'pending') return !task.completed;
    if (currentView === 'completed') return task.completed;
    return true;
  });

  if (activePriorityFilter) {
    filtered = filtered.filter((t) => t.priority === activePriorityFilter);
  }

  const trimmedSearch = searchQuery.trim();
  if (trimmedSearch !== '') {
    const q = trimmedSearch.toLowerCase();
    filtered = filtered.filter(
      (task) =>
        task.title.toLowerCase().includes(q) ||
        task.category.toLowerCase().includes(q) ||
        task.deadline.toLowerCase().includes(q) ||
        (task.rawDeadline ? task.rawDeadline.toLowerCase().includes(q) : false)
    );
  }

  if (taskBadgeCount) {
    taskBadgeCount.textContent = `${filtered.length}`;
  }

  if (filtered.length === 0) {
    taskListEl.innerHTML = '';
    if (tasksLoadError && tasks.length === 0) {
      emptyStateEl.classList.add('hidden');
      return;
    }

    emptyStateEl.classList.remove('hidden');

    if (tasks.length === 0) {
      emptyTitleEl.textContent = 'No routines or tasks yet';
      emptySubtitleEl.textContent = 'Add your first task to start your daily streak!';
      emptyActionText.textContent = 'Add First Task';
      emptyActionBtn.onclick = openModal;
    } else if (trimmedSearch !== '') {
      emptyTitleEl.textContent = 'No matching tasks';
      emptySubtitleEl.textContent = `No routines match "${trimmedSearch}".`;
      emptyActionText.textContent = 'Clear Search';
      emptyActionBtn.onclick = () => {
        if (searchInput) searchInput.value = '';
        if (mobileSearchInput) mobileSearchInput.value = '';
        searchQuery = '';
        if (searchClearBtn) searchClearBtn.classList.add('hidden');
        renderTasks();
      };
    } else if (activePriorityFilter !== null) {
      emptyTitleEl.textContent = `No ${activePriorityFilter} priority tasks`;
      emptySubtitleEl.textContent = `There are no ${activePriorityFilter} priority tasks right now.`;
      emptyActionText.textContent = 'Clear Priority Filter';
      emptyActionBtn.onclick = clearPriorityFilter;
    } else if (currentView === 'pending') {
      emptyTitleEl.textContent = 'All caught up!';
      emptySubtitleEl.textContent = 'You completed all tasks for today. Outstanding!';
      emptyActionText.textContent = 'Add New Task';
      emptyActionBtn.onclick = openModal;
    } else if (currentView === 'completed') {
      emptyTitleEl.textContent = 'No completed tasks yet';
      emptySubtitleEl.textContent = 'Check off your routines as you accomplish them.';
      emptyActionText.textContent = 'View Pending Tasks';
      emptyActionBtn.onclick = () => setView('pending');
    }
    return;
  }

  emptyStateEl.classList.add('hidden');
  taskListEl.innerHTML = '';

  filtered.forEach((task) => {
    const li = document.createElement('li');
    li.id = `row-${task.id}`;
    li.className = 'group relative flex items-center gap-3 sm:gap-4 transition-all duration-150';

    const categoryIcon = getCategoryIcon(task.category, task.title);
    const isRowPending = pendingTaskIds.has(task.id);

    li.innerHTML = `
      <!-- Timeline Node Checkbox -->
      <button 
        type="button" 
        ${isRowPending ? 'disabled' : ''}
        aria-label="${task.completed ? 'Mark pending' : 'Mark completed'}"
        class="checkbox-btn checkbox-animate relative z-10 w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center shrink-0 transition-all duration-150 cursor-pointer active:scale-90 disabled:opacity-60 disabled:cursor-wait ${
          task.completed
            ? 'bg-[#E26D46] text-white shadow-xs'
            : 'border-2 border-stone-300 bg-white hover:border-[#E26D46] text-transparent'
        }"
      >
        <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
        </svg>
      </button>

      <!-- Task Card -->
      <div class="flex-1 bg-white border border-[#F0EBE2] hover:border-[#E5DDD2] shadow-[0_2px_10px_rgba(42,30,23,0.03)] hover:shadow-[0_4px_16px_rgba(42,30,23,0.06)] rounded-2xl sm:rounded-3xl p-3.5 sm:p-4.5 flex items-center justify-between gap-3 transition-all duration-150 ${isRowPending ? 'opacity-60' : ''}">
        
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl ${categoryIcon.bg} ${categoryIcon.text} flex items-center justify-center shrink-0 shadow-2xs">
            ${categoryIcon.icon}
          </div>

          <div class="min-w-0 flex-1">
            <h3 class="task-title text-xs sm:text-sm font-bold text-[#1E1A17] truncate leading-snug transition-colors ${
              task.completed ? 'line-through text-stone-400 font-medium' : ''
            }">
              ${escapeHtml(task.title)}
            </h3>
            <p class="text-[11px] sm:text-xs text-stone-400 font-medium mt-0.5 truncate flex items-center gap-1.5">
              <span>Streak ${task.streak || 3} days</span>
              <span class="text-stone-300">·</span>
              <span class="${task.priority === 'High' ? 'text-[#E26D46] font-semibold' : ''}">${task.priority} Priority</span>
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 sm:gap-3 shrink-0">
          <div class="flex items-center gap-1 text-[11px] sm:text-xs font-semibold text-stone-500 bg-[#FAF7F2] border border-[#F0EBE2] px-2.5 py-1 rounded-full shrink-0">
            <svg class="w-3.5 h-3.5 text-stone-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>${escapeHtml(task.deadline)}</span>
          </div>

          <button 
            type="button" 
            ${isRowPending ? 'disabled' : ''}
            class="delete-btn p-1.5 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all cursor-pointer opacity-70 group-hover:opacity-100 disabled:opacity-40 disabled:cursor-wait"
          >
            <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>

      </div>
    `;

    const checkboxBtn = li.querySelector<HTMLButtonElement>('.checkbox-btn');
    if (checkboxBtn) {
      checkboxBtn.setAttribute('data-id', task.id);
    }

    const deleteBtn = li.querySelector<HTMLButtonElement>('.delete-btn');
    if (deleteBtn) {
      deleteBtn.setAttribute('aria-label', `Delete routine: ${task.title}`);
      deleteBtn.setAttribute('data-id', task.id);
    }

    taskListEl.appendChild(li);
  });

  attachTaskRowHandlers();
}

function attachTaskRowHandlers(): void {
  document.querySelectorAll<HTMLButtonElement>('.checkbox-btn').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!id || pendingTaskIds.has(id)) return;

      const target = tasks.find((t) => t.id === id);
      if (!target) return;

      const nextCompleted = !target.completed;
      pendingTaskIds.add(id);
      btn.disabled = true;
      btn.classList.add('opacity-60', 'cursor-wait');

      try {
        tasksLoadError = null;
        await updateUserTaskCompletion(id, nextCompleted);
        await loadTasksFromSupabase();
      } catch (err: unknown) {
        const msg = formatDatabaseError(err);
        tasksLoadError = msg;
        updateTaskStatusUI();
        showToast(msg);
      } finally {
        pendingTaskIds.delete(id);
        renderTasks();
      }
    };
  });

  document.querySelectorAll<HTMLButtonElement>('.delete-btn').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!id || pendingTaskIds.has(id)) return;

      pendingTaskIds.add(id);
      btn.disabled = true;
      const row = document.getElementById(`row-${id}`);
      if (row) {
        row.classList.add('opacity-60');
      }

      try {
        tasksLoadError = null;
        await deleteUserTask(id);
        if (row) {
          row.classList.add('task-fade-out');
          await new Promise((resolve) => setTimeout(resolve, 160));
        }
        await loadTasksFromSupabase();
        showToast('Task deleted');
      } catch (err: unknown) {
        const msg = formatDatabaseError(err);
        tasksLoadError = msg;
        updateTaskStatusUI();
        showToast(msg);
        if (row) {
          row.classList.remove('opacity-60', 'task-fade-out');
        }
      } finally {
        pendingTaskIds.delete(id);
        renderTasks();
      }
    };
  });
}

function setView(view: 'all' | 'pending' | 'completed'): void {
  currentView = view;

  [navAll, navPending, navCompleted].forEach((btn) => {
    if (btn) {
      btn.className =
        'nav-item w-full flex items-center justify-between px-3.5 py-2.5 text-sm font-medium rounded-2xl transition-all duration-150 text-stone-600 hover:text-stone-900 hover:bg-[#F2ECE3] cursor-pointer';
      const icon = btn.querySelector('svg');
      if (icon) icon.className.baseVal = 'w-4.5 h-4.5 text-stone-400 shrink-0';
    }
  });

  const activeNavBtn =
    view === 'all' ? navAll : view === 'pending' ? navPending : navCompleted;
  if (activeNavBtn) {
    activeNavBtn.className =
      'nav-item w-full flex items-center justify-between px-3.5 py-2.5 text-sm font-semibold rounded-2xl transition-all duration-150 bg-[#FFF3E8] text-[#9A3816] cursor-pointer';
    const icon = activeNavBtn.querySelector('svg');
    if (icon) icon.className.baseVal = 'w-4.5 h-4.5 text-[#E26D46] shrink-0';
  }

  filterTabs.forEach((tab) => {
    const filter = tab.dataset.filter;
    if (filter === view) {
      tab.className =
        'filter-tab px-3 py-1 rounded-full transition-all cursor-pointer bg-white text-[#1E1A17] shadow-2xs font-bold';
    } else {
      tab.className =
        'filter-tab px-3 py-1 rounded-full transition-all cursor-pointer text-stone-600 hover:text-stone-900 font-semibold';
    }
  });

  renderTasks();
}

function setPriorityFilter(priority: 'High' | 'Medium' | 'Low'): void {
  if (activePriorityFilter === priority) {
    activePriorityFilter = null;
  } else {
    activePriorityFilter = priority;
  }
  closeMobileDrawer();
  updateCounts();
  renderTasks();
}

function clearPriorityFilter(): void {
  activePriorityFilter = null;
  updateCounts();
  renderTasks();
}

function clearModalErrors(): void {
  if (taskTitleInput) {
    taskTitleInput.classList.remove('border-red-500', 'focus:ring-red-500/20', 'focus:border-red-500');
  }
  if (taskTitleError) {
    taskTitleError.classList.add('hidden');
  }
  if (modalErrorBanner) {
    modalErrorBanner.classList.add('hidden');
  }
}

function openModal(): void {
  clearModalErrors();
  addTaskModal.classList.remove('hidden');

  if (taskDeadlineInput && !taskDeadlineInput.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    taskDeadlineInput.value = `${yyyy}-${mm}-${dd}`;
  }

  if (taskTitleInput) {
    taskTitleInput.value = '';
    setTimeout(() => taskTitleInput.focus(), 60);
  }
}

function closeModal(): void {
  addTaskModal.classList.add('hidden');
  clearModalErrors();
  addTaskForm.reset();
}

function openMobileDrawer(): void {
  sidebar.classList.remove('-translate-x-full');
  mobileDrawerBackdrop.classList.remove('hidden');
}

function closeMobileDrawer(): void {
  sidebar.classList.add('-translate-x-full');
  mobileDrawerBackdrop.classList.add('hidden');
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =========================================================================
// Auth Form Listeners & Event Handlers
// =========================================================================

function setupAuthEventListeners() {
  // Navigation between auth cards
  if (gotoSignupBtn) gotoSignupBtn.onclick = () => { hasActiveAuthUrlError = false; showAuthCard('signup'); };
  if (gotoLoginBtn) gotoLoginBtn.onclick = () => { hasActiveAuthUrlError = false; showAuthCard('login'); };
  if (gotoForgotPwd) gotoForgotPwd.onclick = () => { hasActiveAuthUrlError = false; showAuthCard('forgot'); };
  if (forgotBackBtn) forgotBackBtn.onclick = () => { hasActiveAuthUrlError = false; showAuthCard('login'); };
  if (verifyBackBtn) verifyBackBtn.onclick = () => { hasActiveAuthUrlError = false; showAuthCard('login'); };

  // Password Visibility Toggles
  if (loginPassword && loginTogglePwd && loginEyeIcon) {
    setupPasswordToggle(loginPassword, loginTogglePwd, loginEyeIcon);
  }
  if (signupPassword && signupTogglePwd && signupEyeIcon) {
    setupPasswordToggle(signupPassword, signupTogglePwd, signupEyeIcon);
  }

  // 1. LOGIN FORM SUBMISSION
  if (loginForm) {
    loginForm.onsubmit = async (e) => {
      e.preventDefault();
      const email = loginEmail.value.trim();
      const password = loginPassword.value;

      if (!email || !password) {
        if (loginErrorBanner && loginErrorText) {
          loginErrorText.textContent = 'Please enter both your email and password.';
          loginErrorBanner.classList.remove('hidden');
        }
        return;
      }

      // Check Supabase configuration first
      if (!isSupabaseConfigured()) {
        if (loginErrorBanner && loginErrorText) {
          loginErrorText.textContent =
            'Supabase is not configured yet. Please configure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in your environment.';
          loginErrorBanner.classList.remove('hidden');
        }
        return;
      }

      // UI loading state
      loginSubmitBtn.disabled = true;
      loginSubmitText.textContent = 'Signing in...';
      loginSpinner.classList.remove('hidden');
      loginErrorBanner.classList.add('hidden');

      try {
        hasActiveAuthUrlError = false;
        await signInWithEmail(email, password);
        showToast('Signed in successfully!');
      } catch (err: unknown) {
        loginErrorText.textContent = formatAuthError(err as Error);
        loginErrorBanner.classList.remove('hidden');
      } finally {
        loginSubmitBtn.disabled = false;
        loginSubmitText.textContent = 'Sign In';
        loginSpinner.classList.add('hidden');
      }
    };
  }

  // 2. SIGNUP FORM SUBMISSION
  if (signupForm) {
    signupForm.onsubmit = async (e) => {
      e.preventDefault();
      const name = signupName.value.trim();
      const email = signupEmail.value.trim();
      const password = signupPassword.value;
      const confirmPassword = signupConfirmPassword.value;

      if (!name || !email || !password || !confirmPassword) {
        signupErrorText.textContent = 'Please fill out all required fields.';
        signupErrorBanner.classList.remove('hidden');
        return;
      }

      if (password.length < 6) {
        signupErrorText.textContent = 'Password must be at least 6 characters long.';
        signupErrorBanner.classList.remove('hidden');
        return;
      }

      if (password !== confirmPassword) {
        signupErrorText.textContent = 'Passwords do not match. Please verify and retype.';
        signupErrorBanner.classList.remove('hidden');
        return;
      }

      if (!isSupabaseConfigured()) {
        signupErrorText.textContent =
          'Supabase is not configured yet. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to your environment.';
        signupErrorBanner.classList.remove('hidden');
        return;
      }

      signupSubmitBtn.disabled = true;
      signupSubmitText.textContent = 'Creating account...';
      signupSpinner.classList.remove('hidden');
      signupErrorBanner.classList.add('hidden');

      try {
        const result = await signUpWithEmail(email, password, name);
        if (result.user && !result.session) {
          // Email confirmation required
          if (verifyEmailDisplay) verifyEmailDisplay.textContent = email;
          showAuthCard('verify');
        } else if (result.session) {
          showToast(`Welcome to Doto, ${name}!`);
        }
      } catch (err: unknown) {
        signupErrorText.textContent = formatAuthError(err);
        signupErrorBanner.classList.remove('hidden');
      } finally {
        signupSubmitBtn.disabled = false;
        signupSubmitText.textContent = 'Create Account';
        signupSpinner.classList.add('hidden');
      }
    };
  }

  // 3. FORGOT PASSWORD FORM SUBMISSION
  if (forgotForm) {
    forgotForm.onsubmit = async (e) => {
      e.preventDefault();
      const email = forgotEmail.value.trim();

      if (!email) {
        forgotMessageBanner.className = 'mb-4 p-3 text-xs rounded-2xl flex items-start gap-2 bg-red-50 border border-red-200 text-red-700';
        const msgSpan = document.createElement('span');
        msgSpan.textContent = 'Please enter your email address.';
        forgotMessageBanner.replaceChildren(msgSpan);
        forgotMessageBanner.classList.remove('hidden');
        return;
      }

      if (!isSupabaseConfigured()) {
        forgotMessageBanner.className = 'mb-4 p-3 text-xs rounded-2xl flex items-start gap-2 bg-red-50 border border-red-200 text-red-700';
        const msgSpan = document.createElement('span');
        msgSpan.textContent = hasForbiddenSecretKey()
          ? 'Secret or service_role keys cannot be used in the browser. Configure VITE_SUPABASE_PUBLISHABLE_KEY.'
          : 'Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.';
        forgotMessageBanner.replaceChildren(msgSpan);
        forgotMessageBanner.classList.remove('hidden');
        return;
      }

      forgotSubmitBtn.disabled = true;
      forgotSubmitText.textContent = 'Sending link...';
      forgotSpinner.classList.remove('hidden');
      forgotMessageBanner.classList.add('hidden');

      try {
        await requestPasswordReset(email);
        forgotMessageBanner.className = 'mb-4 p-3 text-xs rounded-2xl flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-800';
        const msgSpan = document.createElement('span');
        const emailStrong = document.createElement('strong');
        emailStrong.textContent = email;
        msgSpan.append(
          document.createTextNode('A password reset link has been sent to '),
          emailStrong,
          document.createTextNode('. Please check your inbox.')
        );
        forgotMessageBanner.replaceChildren(msgSpan);
        forgotMessageBanner.classList.remove('hidden');
      } catch (err: unknown) {
        forgotMessageBanner.className = 'mb-4 p-3 text-xs rounded-2xl flex items-start gap-2 bg-red-50 border border-red-200 text-red-700';
        const msgSpan = document.createElement('span');
        msgSpan.textContent = formatAuthError(err as Error);
        forgotMessageBanner.replaceChildren(msgSpan);
        forgotMessageBanner.classList.remove('hidden');
      } finally {
        forgotSubmitBtn.disabled = false;
        forgotSubmitText.textContent = 'Send Reset Link';
        forgotSpinner.classList.add('hidden');
      }
    };
  }

  // 4. RESET / UPDATE PASSWORD SUBMISSION
  if (resetPwdForm) {
    resetPwdForm.onsubmit = async (e) => {
      e.preventDefault();
      const pwd = newPasswordInput.value;
      const confirmPwd = newPasswordConfirm.value;

      if (!pwd || !confirmPwd) {
        resetPwdErrorText.textContent = 'Please enter and confirm your new password.';
        resetPwdErrorBanner.classList.remove('hidden');
        return;
      }

      if (pwd.length < 6) {
        resetPwdErrorText.textContent = 'Password must be at least 6 characters long.';
        resetPwdErrorBanner.classList.remove('hidden');
        return;
      }

      if (pwd !== confirmPwd) {
        resetPwdErrorText.textContent = 'Passwords do not match.';
        resetPwdErrorBanner.classList.remove('hidden');
        return;
      }

      resetPwdSubmitBtn.disabled = true;
      resetPwdSubmitText.textContent = 'Updating...';
      resetPwdSpinner.classList.remove('hidden');
      resetPwdErrorBanner.classList.add('hidden');

      try {
        const activeSession = await getSession();
        if (!activeSession) {
          showInvalidRecoveryLinkError();
          return;
        }

        const updateResult = await updateUserPassword(pwd);
        isPasswordRecoveryMode = false;
        resetPwdForm.reset();
        cleanAuthUrlParams();

        const refreshedSession = await getSession();
        const authenticatedUser = updateResult?.user ?? refreshedSession?.user ?? currentUser;

        showToast('Password updated successfully! Welcome back.');
        setAuthState(authenticatedUser || null);
      } catch (err: unknown) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const lower = rawMessage.toLowerCase();
        if (
          lower.includes('session') ||
          lower.includes('expired') ||
          lower.includes('invalid') ||
          lower.includes('jwt') ||
          lower.includes('otp')
        ) {
          showInvalidRecoveryLinkError();
        } else {
          resetPwdErrorText.textContent = formatAuthError(err as Error);
          resetPwdErrorBanner.classList.remove('hidden');
        }
      } finally {
        resetPwdSubmitBtn.disabled = false;
        resetPwdSubmitText.textContent = 'Update Password';
        resetPwdSpinner.classList.add('hidden');
      }
    };
  }

  // LOGOUT BUTTONS
  const handleSignOut = async () => {
    isPasswordRecoveryMode = false;
    pendingAuthUrlError = null;
    hasActiveAuthUrlError = false;
    await signOutUser();
    showToast('Signed out of Doto');
  };

  if (sidebarLogoutBtn) sidebarLogoutBtn.onclick = handleSignOut;
  if (mobileLogoutBtn) mobileLogoutBtn.onclick = handleSignOut;
}

function handleAuthStateEvent(event: string, newSession: Session | null): void {
  if (event === 'PASSWORD_RECOVERY') {
    pendingAuthUrlError = null;
    hasActiveAuthUrlError = false;
    isPasswordRecoveryMode = true;
    currentUser = newSession?.user ?? currentUser;
    if (isAppBootstrapped) {
      enterPasswordRecoveryMode();
    }
    return;
  }

  if (event === 'SIGNED_OUT') {
    isPasswordRecoveryMode = false;
    hasActiveAuthUrlError = false;
    if (isAppBootstrapped) {
      setAuthState(null);
    }
    return;
  }

  // Prevent INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED, or USER_UPDATED from overriding recovery mode
  if (isPasswordRecoveryMode) {
    currentUser = newSession?.user ?? currentUser;
    if (isAppBootstrapped) {
      enterPasswordRecoveryMode();
    }
    return;
  }

  if (event === 'SIGNED_IN') {
    hasActiveAuthUrlError = false;
  }

  if (pendingAuthUrlError || hasActiveAuthUrlError) {
    return;
  }

  if (isAppBootstrapped) {
    setAuthState(newSession?.user || null);
  }
}

if (isSupabaseConfigured()) {
  onAuthStateChange(handleAuthStateEvent);
}

// =========================================================================
// Initialization
// =========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  setupHeaderDate();
  renderWeekStrip();
  setupAuthEventListeners();

  // Navigation clicks (Sidebar)
  if (navAll) navAll.onclick = () => { setView('all'); closeMobileDrawer(); };
  if (navPending) navPending.onclick = () => { setView('pending'); closeMobileDrawer(); };
  if (navCompleted) navCompleted.onclick = () => { setView('completed'); closeMobileDrawer(); };

  // Segmented filter tabs clicks
  filterTabs.forEach((tab) => {
    tab.onclick = () => {
      const filter = tab.dataset.filter as 'all' | 'pending' | 'completed';
      if (filter) setView(filter);
    };
  });

  // Priority filters
  if (priorityHighBtn) priorityHighBtn.onclick = () => setPriorityFilter('High');
  if (priorityMediumBtn) priorityMediumBtn.onclick = () => setPriorityFilter('Medium');
  if (priorityLowBtn) priorityLowBtn.onclick = () => setPriorityFilter('Low');
  if (priorityClearBtn) priorityClearBtn.onclick = clearPriorityFilter;
  if (clearFilterBtn) clearFilterBtn.onclick = clearPriorityFilter;

  // Search input handler
  const handleSearchInput = (val: string) => {
    searchQuery = val;
    if (searchInput) searchInput.value = val;
    if (mobileSearchInput) mobileSearchInput.value = val;
    if (searchClearBtn) {
      if (val.trim().length > 0) {
        searchClearBtn.classList.remove('hidden');
      } else {
        searchClearBtn.classList.add('hidden');
      }
    }
    renderTasks();
  };

  if (searchInput) {
    searchInput.oninput = (e) => handleSearchInput((e.target as HTMLInputElement).value);
  }
  if (mobileSearchInput) {
    mobileSearchInput.oninput = (e) => handleSearchInput((e.target as HTMLInputElement).value);
  }

  if (searchClearBtn) {
    searchClearBtn.onclick = () => {
      handleSearchInput('');
      searchInput?.focus();
    };
  }

  // Global Shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput?.focus();
    }
    if (e.key === 'Escape') {
      if (!addTaskModal.classList.contains('hidden')) {
        closeModal();
      } else if (searchInput && document.activeElement === searchInput && searchInput.value) {
        handleSearchInput('');
        searchInput.blur();
      }
    }
  });

  // Modal open triggers
  if (openAddTaskBtn) openAddTaskBtn.onclick = openModal;
  if (fabAddTaskBtn) fabAddTaskBtn.onclick = openModal;
  if (mobileAddBtn) mobileAddBtn.onclick = openModal;
  if (closeModalBtn) closeModalBtn.onclick = closeModal;
  if (cancelModalBtn) cancelModalBtn.onclick = closeModal;

  // Clear validation on title input
  if (taskTitleInput) {
    taskTitleInput.addEventListener('input', () => {
      if (taskTitleInput.value.trim().length > 0) {
        clearModalErrors();
      }
    });
  }

  // Toast close
  if (toastCloseBtn) {
    toastCloseBtn.onclick = hideToast;
  }

  // Retry fetch tasks button
  if (tasksRetryBtn) {
    tasksRetryBtn.onclick = () => {
      void loadTasksFromSupabase();
    };
  }

  // Add Task submit (Inserts into Supabase public.tasks)
  if (addTaskForm) {
    addTaskForm.onsubmit = async (e) => {
      e.preventDefault();

      const rawTitle = taskTitleInput ? taskTitleInput.value : '';
      const title = rawTitle.trim();

      if (!title) {
        if (taskTitleInput) {
          taskTitleInput.classList.add('border-red-500', 'focus:ring-red-500/20', 'focus:border-red-500');
          taskTitleInput.focus();
        }
        if (taskTitleError) {
          taskTitleError.classList.remove('hidden');
        }
        return;
      }

      const rawDate = taskDeadlineInput ? taskDeadlineInput.value.trim() : '';
      const deadlineValue = rawDate !== '' ? rawDate : null;

      if (modalErrorBanner) modalErrorBanner.classList.add('hidden');
      if (createTaskBtn) createTaskBtn.disabled = true;
      if (createTaskSpinner) createTaskSpinner.classList.remove('hidden');
      if (createTaskText) createTaskText.textContent = 'Saving...';

      try {
        await createUserTask(title, deadlineValue);

        clearModalErrors();
        addTaskForm.reset();
        closeModal();

        if (currentView === 'completed') {
          setView('all');
        }

        await loadTasksFromSupabase();
        showToast('Task added to your routine!');
      } catch (err: unknown) {
        const msg = formatDatabaseError(err);
        if (modalErrorBanner && modalErrorText) {
          modalErrorText.textContent = msg;
          modalErrorBanner.classList.remove('hidden');
        } else {
          showToast(msg);
        }
      } finally {
        if (createTaskBtn) createTaskBtn.disabled = false;
        if (createTaskSpinner) createTaskSpinner.classList.add('hidden');
        if (createTaskText) createTaskText.textContent = 'Create Task';
      }
    };
  }

  // Modal backdrop click
  addTaskModal.onclick = (e) => {
    if (e.target === addTaskModal) {
      closeModal();
    }
  };

  // Mobile drawer
  if (mobileMenuBtn) mobileMenuBtn.onclick = openMobileDrawer;
  if (mobileDrawerClose) mobileDrawerClose.onclick = closeMobileDrawer;
  if (mobileDrawerBackdrop) mobileDrawerBackdrop.onclick = closeMobileDrawer;

  // -------------------------------------------------------------
  // Supabase Status Widget (Dev Only) & Client Initialization
  // -------------------------------------------------------------
  if (import.meta.env.DEV) {
    initSupabaseStatusWidget();
  }

  isAppBootstrapped = true;

  if (isSupabaseConfigured()) {
    if (pendingAuthUrlError) {
      const urlError = pendingAuthUrlError;
      pendingAuthUrlError = null;
      hasActiveAuthUrlError = true;
      isPasswordRecoveryMode = false;
      await getSession();
      displayAuthUrlErrorBanner(urlError);
      cleanAuthUrlParams();
    } else if (initialRecoveryTokenHash) {
      isPasswordRecoveryMode = true;
      try {
        const result = await verifyRecoveryTokenHash(initialRecoveryTokenHash);
        cleanAuthUrlParams();
        currentUser = result?.user ?? result?.session?.user ?? currentUser;
        enterPasswordRecoveryMode();
        if (!result?.session && !result?.user) {
          showInvalidRecoveryLinkError();
        }
      } catch {
        cleanAuthUrlParams();
        currentUser = null;
        enterPasswordRecoveryMode();
        showInvalidRecoveryLinkError();
      }
    } else {
      const session = await getSession();

      if (isPasswordRecoveryMode || hasRecoveryUrlSignal()) {
        isPasswordRecoveryMode = true;
        if (initialHadImplicitTokens && hasUnconsumedImplicitAccessToken()) {
          // GoTrueClient leaves hash tokens intact when URL token validation fails
          cleanAuthUrlParams();
          currentUser = null;
          enterPasswordRecoveryMode();
          showInvalidRecoveryLinkError();
        } else {
          currentUser = session?.user ?? currentUser;
          enterPasswordRecoveryMode();
          if (!session) {
            showInvalidRecoveryLinkError();
          }
        }
      } else {
        setAuthState(session?.user || null);
      }
    }
  } else {
    // Keep Doto active and functional in unconfigured state
    setAuthState(null);
  }
});
