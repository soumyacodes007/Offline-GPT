import Image from "next/image";

type Props = {
  className?: string;
};

export function OfflineGPTMark(props: Props) {
  return (
    <Image
      src="/offlinegpt-mark.svg"
      alt=""
      aria-hidden="true"
      className={props.className}
      width={834}
      height={649}
      unoptimized
    />
  );
}
