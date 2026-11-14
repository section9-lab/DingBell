import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ApiError, type Identity } from '../lib/api';
import { avatarSeedFromImage, defaultAvatarSeed, randomAvatarSeed } from '../lib/avatar';
import { updateProfile } from '../lib/profile-api';
import { ErrorNotice } from './identity-shared';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';
import { UserAvatar } from './user-avatar';

const avatarChoices = 12;

function makeChoices(selected: string) {
  const choices = new Set([selected]);
  while (choices.size < avatarChoices) choices.add(randomAvatarSeed());
  return [...choices];
}

export function ProfileSettingsCard({ identity }: { identity: Identity }) {
  const queryClient = useQueryClient();
  const user = identity.session?.user;
  const fallbackSeed = user ? defaultAvatarSeed(user.id) : '';
  const savedSeed = user ? avatarSeedFromImage(user.image, fallbackSeed) : '';
  const [name, setName] = useState(user?.name ?? '');
  const [seed, setSeed] = useState(savedSeed);
  const [choices, setChoices] = useState(() => makeChoices(savedSeed));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');

  if (!user) return null;

  const trimmed = name.trim();
  const invalidName = !trimmed || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed);
  const dirty = trimmed !== user.name || seed !== savedSeed;

  function reroll() {
    const next = randomAvatarSeed();
    setSeed(next);
    setChoices(makeChoices(next));
    setMessage('');
  }

  async function save() {
    if (pending || invalidName || !dirty) return;
    setPending(true);
    setError(undefined);
    setMessage('');
    try {
      const saved = await updateProfile({ name: trimmed, avatarSeed: seed });
      setName(saved.user.name);
      setSeed(avatarSeedFromImage(saved.user.image, fallbackSeed));
      queryClient.setQueryData<Identity>(['identity'], (current) =>
        current?.session
          ? { ...current, session: { ...current.session, user: saved.user } }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['team'] });
      setMessage('个人资料已保存。');
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>个人资料</CardTitle>
        <CardDescription>
          姓名和头像只属于你的账号；邮箱用于登录和通知，不能在这里修改。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form
          id="profile-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          aria-busy={pending}
        >
          <FieldGroup>
            <Field data-invalid={invalidName} data-disabled={pending}>
              <FieldLabel htmlFor="profile-name">姓名</FieldLabel>
              <Input
                id="profile-name"
                value={name}
                maxLength={80}
                autoComplete="name"
                disabled={pending}
                aria-invalid={invalidName}
                aria-describedby={invalidName ? 'profile-name-error' : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setMessage('');
                }}
              />
              {invalidName && (
                <FieldError id="profile-name-error">
                  请输入 1–80 个字符，且不要包含换行或控制字符。
                </FieldError>
              )}
            </Field>
            <Field data-disabled>
              <FieldLabel htmlFor="profile-email">邮箱</FieldLabel>
              <Input
                id="profile-email"
                value={user.email}
                readOnly
                disabled
                autoComplete="email"
                aria-describedby="profile-email-help"
              />
              <FieldDescription id="profile-email-help">
                邮箱用于登录、验证和通知，当前版本不支持修改。
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">头像</p>
              <p className="text-xs text-muted-foreground">
                选择一个 Micah 风格头像；不选时会使用根据账号生成的默认头像。
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={reroll}>
              <RefreshCw data-icon="inline-start" />
              换一批
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <UserAvatar name={trimmed || user.name} seed={seed} size={72} />
            <div role="radiogroup" aria-label="选择头像" className="grid grid-cols-6 gap-2">
              {choices.map((option, index) => {
                const selected = option === seed;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`选择头像 ${index + 1}`}
                    disabled={pending}
                    className={`rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${selected ? 'ring-2 ring-[var(--ring)] ring-offset-2 ring-offset-background' : 'hover:ring-2 hover:ring-border'}`}
                    onClick={() => {
                      setSeed(option);
                      setMessage('');
                    }}
                  >
                    <UserAvatar name={trimmed || user.name} seed={option} size={44} />
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            头像风格：
            <a
              className="underline underline-offset-4"
              href="https://www.dicebear.com/styles/micah/"
              target="_blank"
              rel="noreferrer"
            >
              Micah
            </a>{' '}
            by{' '}
            <a
              className="underline underline-offset-4"
              href="https://dribbble.com/micahlanier"
              target="_blank"
              rel="noreferrer"
            >
              Micah Lanier
            </a>{' '}
            ·{' '}
            <a
              className="underline underline-offset-4"
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noreferrer"
            >
              CC BY 4.0
            </a>{' '}
            · 由 DiceBear 渲染
          </p>
        </div>

        {error != null && (
          <ErrorNotice
            error={error instanceof ApiError ? error : new ApiError('OPERATION_UNCONFIRMED')}
          />
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          type="submit"
          form="profile-settings-form"
          disabled={pending || invalidName || !dirty}
        >
          {pending && <Spinner />}
          保存个人资料
        </Button>
        {dirty && !pending && <span className="text-xs text-muted-foreground">有未保存的修改</span>}
      </CardFooter>
    </Card>
  );
}
