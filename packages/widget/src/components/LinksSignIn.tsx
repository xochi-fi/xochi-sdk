import { truncateAddress } from "../utils/format.js";

export const LINKS_SIGN_IN_LABEL = "Sign in with your wallet to see transaction links";

export type LinksSignInAction =
  | {
      kind: "sign_in";
      onSignIn: () => void;
      isSigningIn: boolean;
    }
  | {
      kind: "switch_wallet";
      ownerWallet: string;
    };

const switchWalletLabel = (ownerWallet: string): string =>
  `Switch to ${truncateAddress(ownerWallet)} to see transaction links`;

export function LinksSignIn({
  action,
  className,
}: {
  action: LinksSignInAction;
  className: string;
}) {
  if (action.kind === "switch_wallet") {
    return <span role="note">{switchWalletLabel(action.ownerWallet)}</span>;
  }
  return (
    <button
      type="button"
      className={className}
      onClick={action.onSignIn}
      disabled={action.isSigningIn}
    >
      {action.isSigningIn ? "Check your wallet..." : LINKS_SIGN_IN_LABEL}
    </button>
  );
}
