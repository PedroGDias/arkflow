export const TEAM_MEMBERS = [
  {
    id: 'carla',
    initials: 'CA',
    name: 'Carla',
    role: { EN: 'Bookings Specialist', ES: 'Especialista de reservas' },
    avatarBg: '#e4f2e8',
    avatarColor: '#1a7a3a',
    automationIds: [1, 2, 3],
  },
  {
    id: 'sofia',
    initials: 'SO',
    name: 'Sofía',
    role: { EN: 'Customer Service Specialist', ES: 'Especialista de atención al cliente' },
    avatarBg: '#e8eef8',
    avatarColor: '#2a5ab3',
    automationIds: [] as number[],
  },
  {
    id: 'lucas',
    initials: 'LU',
    name: 'Lucas',
    role: { EN: 'Operations Specialist', ES: 'Especialista de operaciones' },
    avatarBg: '#f5eae4',
    avatarColor: '#b35a2a',
    automationIds: [] as number[],
  },
] as const
