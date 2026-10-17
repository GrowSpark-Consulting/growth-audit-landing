import Image from "next/image";

export function BrandLogo() {
  return (
    <Image
      className="brand-logo"
      src="/images/growspark-logo.png"
      alt=""
      width={1920}
      height={660}
    />
  );
}
