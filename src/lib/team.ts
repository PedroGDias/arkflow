export const TEAM_MEMBERS = [
  {
    id: 'carla',
    initials: 'CA',
    name: 'Carla',
    role: { EN: 'Bookings Specialist', ES: 'Especialista de reservas' },
    avatarBg: 'var(--brand-bg)',
    avatarColor: 'var(--brand)',
    // Reservations lifecycle (incl. changes + cancellations)
    automationIds: [1, 2, 3, 4, 5] as number[],
  },
  {
    id: 'lucas',
    initials: 'LU',
    name: 'Lucas',
    role: { EN: 'Finance & Admin Specialist', ES: 'Especialista de finanzas y administración' },
    avatarBg: '#f5eae4',
    avatarColor: '#b35a2a',
    // Back-office: fiscal data + invoices
    automationIds: [6, 7, 8] as number[],
  },
  {
    id: 'sofia',
    initials: 'SO',
    name: 'Sofía',
    role: { EN: 'Customer Support Specialist', ES: 'Especialista de atención al cliente' },
    avatarBg: '#e8eef8',
    avatarColor: '#2a5ab3',
    // Customer-facing post-booking comms + follow-ups
    automationIds: [] as number[],
  },
] as const
