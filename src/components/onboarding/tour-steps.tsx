import type { Step } from 'react-joyride'

export const tourSteps: Array<Step> = [
  // Step 1: Welcome
  {
    target: 'body',
    placement: 'center',
    title: 'Welcome to Agorax! ⚕',
    content: (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <img
          src="/agorax-icon-512.png"
          alt="Agorax"
          style={{ width: 48, height: 48, borderRadius: 12 }}
        />
        <p style={{ textAlign: 'center', margin: 0 }}>
          Your AI-powered command center for managing agents, chats, files, and
          more. Let&apos;s take a quick tour!
        </p>
      </div>
    ),
    disableBeacon: true,
  },
  // Step 2: Sidebar
  {
    target: '[data-tour="sidebar-container"]',
    placement: 'right',
    title: 'Sidebar Navigation',
    content:
      'Navigate between all your tools here. Collapse/expand sections to customize your workspace.',
  },
  // Step 3: Dashboard
  {
    target: '[data-tour="dashboard"]',
    placement: 'right',
    title: 'Your Dashboard',
    content:
      'Your overview of sessions, usage, and activity. See everything at a glance.',
  },
  // Step 4: Agent Hub
  {
    target: '[data-tour="agent-hub"]',
    placement: 'right',
    title: 'Agent Hub',
    content:
      'Manage your AI agents and configurations. Create custom agents with specialized behaviors.',
  },
  // Step 5: Skills
  {
    target: '[data-tour="skills"]',
    placement: 'right',
    title: 'Skills Library',
    content:
      'Browse and install agent skills to extend capabilities. Add new tools and abilities to your agents.',
  },
  // Step 6: Terminal
  {
    target: '[data-tour="terminal"]',
    placement: 'right',
    title: 'Built-in Terminal',
    content:
      'Built-in terminal for quick commands. Execute shell commands without leaving Agorax.',
  },
  // Step 7: Usage Meter (in header)
  {
    target: '[data-tour="usage-meter"]',
    placement: 'bottom',
    title: 'Usage Monitor',
    content:
      'Monitor your AI provider usage in real-time. Track costs and API consumption.',
  },
  // Step 8: Settings
  {
    target: '[data-tour="settings"]',
    placement: 'right',
    title: 'Settings & Customization',
    content:
      'Configure providers, themes, accent colors, and more. Make Agorax yours.',
  },
  // Step 9: Finish
  {
    target: 'body',
    placement: 'center',
    title: "You're all set! 🎉",
    content:
      'Start chatting with your AI, explore the tools, and customize Agorax to fit your workflow. Need help? Press ? to see all keyboard shortcuts.',
  },
]
