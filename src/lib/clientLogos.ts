import { supabase } from './supabase'

const DEFAULT_CLIENT_LOGO = '/logos/android-chrome-192x192.png'

export function clientLogoUrl(logoPath: string | null | undefined) {
  const path = (logoPath ?? '').trim()
  if (!path) return DEFAULT_CLIENT_LOGO
  if (!supabase) return DEFAULT_CLIENT_LOGO

  const { data } = supabase.storage.from('client-logos').getPublicUrl(path)
  return data.publicUrl || DEFAULT_CLIENT_LOGO
}

export async function uploadClientLogo(args: { clientId: number; file: File }) {
  if (!supabase) throw new Error('Supabase is not configured')
  const { clientId, file } = args

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const ext = safeName.includes('.') ? safeName.split('.').pop() : null
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const objectPath = `clients/${clientId}/${ts}${ext ? `.${ext}` : ''}`

  const { error: upErr } = await supabase.storage
    .from('client-logos')
    .upload(objectPath, file, { upsert: true, contentType: file.type || undefined, cacheControl: '3600' })
  if (upErr) throw upErr

  const { error: dbErr } = await supabase.from('clients').update({ logo_path: objectPath }).eq('id', clientId)
  if (dbErr) throw dbErr

  return objectPath
}

