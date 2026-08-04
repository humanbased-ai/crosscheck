import chalk from 'chalk'
import { formatSkillIdentity } from '../skills/catalog.js'
import { installSkill, SkillInstallError } from '../skills/installer.js'

export async function runSkillInstall(source: string): Promise<void> {
  try {
    const skill = await installSkill(source)
    console.log(chalk.green(`✓ Installed ${formatSkillIdentity(skill)}`))
    console.log(chalk.dim(`  ${skill.path}`))
    console.log(chalk.dim('  Re-run crosscheck onboard to enable it.'))
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(err instanceof SkillInstallError ? 1 : 2)
  }
}
