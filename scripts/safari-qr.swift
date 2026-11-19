import AppKit
import CoreImage
let input = FileHandle.standardInput.readDataToEndOfFile()
let filter = CIFilter(name: "CIQRCodeGenerator")!
filter.setValue(input, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
let raw = filter.outputImage!
let quiet = raw.extent.insetBy(dx: -4, dy: -4)
let white = CIImage(color: .white).cropped(to: quiet)
let image = raw.composited(over: white).transformed(by: .init(scaleX: 8, y: 8))
let context = CIContext(options: [.useSoftwareRenderer: false])
let cg = context.createCGImage(image, from: image.extent)!
let bitmap = NSBitmapImageRep(cgImage: cg)
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
