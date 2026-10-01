import {
  BarChart3, BedDouble, BookOpen, Brain, Calendar, Camera, Check, Clock, Code2, Cog, Database, Eye, FileText,
  Flame, Globe, Heart, Landmark, Leaf, Lightbulb, LineChart, Mail, MapPin, Megaphone, MessageCircle, Package,
  PieChart, Plane, Rocket, Search, Shield, ShoppingCart, Sparkles, Star, Tag, Target, TrendingUp, User, Users,
  Wallet, Workflow, type LucideIcon,
} from 'lucide-react';

/**
 * The board icons by name. The list is the sidecar's BOARD_ICONS
 * (CinderpawAgent/src/artifacts/board.ts); a name not here draws nothing,
 * never a broken glyph.
 */
export const BOARD_ICONS: Record<string, LucideIcon> = {
  users: Users, user: User, flame: Flame, 'bar-chart': BarChart3, 'line-chart': LineChart, 'pie-chart': PieChart,
  brain: Brain, cog: Cog, file: FileText, database: Database, plane: Plane, bed: BedDouble, wallet: Wallet,
  'map-pin': MapPin, calendar: Calendar, mail: Mail, search: Search, megaphone: Megaphone, heart: Heart, eye: Eye,
  target: Target, rocket: Rocket, tag: Tag, star: Star, check: Check, clock: Clock, globe: Globe, camera: Camera,
  cart: ShoppingCart, message: MessageCircle, lightbulb: Lightbulb, shield: Shield, leaf: Leaf, landmark: Landmark,
  sparkles: Sparkles, 'trending-up': TrendingUp, package: Package, code: Code2, workflow: Workflow, book: BookOpen,
};

export function boardIcon(name: string | undefined): LucideIcon | null {
  return (name && BOARD_ICONS[name]) || null;
}
