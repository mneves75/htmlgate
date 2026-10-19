class Htmlgate < Formula
  desc "Publish HTML pages and sites to your own htmlgate Instance and get a URL"
  homepage "https://github.com/mneves75/htmlgate"
  # This formula must stay in the tap's Formula/ directory to resolve its source archive.
  url "file://#{Pathname(__FILE__).realpath.dirname}/sources/b476ab31652540c02da3b6fd00f61836f9cc50c718034669ece9017e62d76817.tar"
  sha256 "b476ab31652540c02da3b6fd00f61836f9cc50c718034669ece9017e62d76817"
  version "0.1.1"
  revision 1
  license "MIT"

  depends_on "node"

  resource "typescript" do
    url "https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz"
    sha256 "da2513f4b95176d6dde8b51aab7afe8a927656c9d277369793f77f7e59371c08"
  end

  # TypeScript 7's tsc is a launcher for a native compiler shipped as a platform package.
  on_arm do
    resource "typescript-darwin-arm64" do
      url "https://registry.npmjs.org/@typescript/typescript-darwin-arm64/-/typescript-darwin-arm64-7.0.2.tgz"
      sha256 "902e2fe1cf0799198ef902c6b8c310a450fef629a6baba41d45641ef75c04ebd"
    end
  end

  on_intel do
    resource "typescript-darwin-x64" do
      url "https://registry.npmjs.org/@typescript/typescript-darwin-x64/-/typescript-darwin-x64-7.0.2.tgz"
      sha256 "eba158cb54050f723d5ff781438f33de5640054440bb4f2bd170cfe9bc2eb551"
    end
  end

  resource "types-node" do
    url "https://registry.npmjs.org/@types/node/-/node-24.19.0.tgz"
    sha256 "fd501fe34c262aa03bdff545d80c58f4ae3084fc426a5ae9e9448fe7a725e9cd"
  end

  resource "undici-types" do
    url "https://registry.npmjs.org/undici-types/-/undici-types-7.24.6.tgz"
    sha256 "2abf595a86b87dd22951218848ec4ad89c018db0e656716dc04b8b2f9290a0f4"
  end

  def install
    odie "htmlgate source archive must contain the CLI root" unless (buildpath/"package.json").exist?
    typescript_platform = "typescript-darwin-#{Hardware::CPU.arm? ? "arm64" : "x64"}"
    resource("typescript").stage(buildpath/"node_modules/typescript")
    resource(typescript_platform).stage(buildpath/"node_modules/@typescript/#{typescript_platform}")
    resource("types-node").stage(buildpath/"node_modules/@types/node")
    resource("undici-types").stage(buildpath/"node_modules/undici-types")
    system Formula["node"].opt_bin/"node", "node_modules/typescript/bin/tsc", "-p", "."
    libexec.install "dist", "package.json"
    prefix.install "LICENSE", "README.md"
    (bin/"htmlgate").write <<~EOS
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/bin.js" "$@"
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/htmlgate --version").strip
  end
end
